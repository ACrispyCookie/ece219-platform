"""Safe team deletion contracts against isolated synthetic HTTP/SQLite state."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Event

import pytest

from test_deletion_impact import client, create, lab, exercise, upload, populated, impact, deps, EMPTY, zip_bytes, legacy_details
from lab_catalog.service import COLUMNS


def team(c, base, **fields):
    obj = create(c, base + '/teams', {'label': 'Synthetic team', **fields})
    return base + '/teams/' + obj['id'], obj


def export(c, base):
    r = c.get('/api/v1' + base + '/export')
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.parametrize('revision', ['0', '-1', 'bad', '1.5', ''])
def test_team_delete_validates_optional_revision_before_writing(client, revision):
    base, _ = lab(client)
    path, _ = team(client, base)
    unused = upload(client, base, team_id=path.rsplit('/', 1)[1])
    before = export(client, base)
    assert client.delete('/api/v1' + path + '?revision=' + revision).status_code == 422
    assert export(client, base) == before
    assert client.get('/api/v1/files/' + unused['id']).json() == unused


def test_team_revision_conflict_precedes_diagnostics_and_cleanup(client):
    base, _, _, obj, *_ = populated(client)
    path = base + '/teams/' + obj['id']
    unused = upload(client, base, team_id=obj['id'])
    changed = client.patch('/api/v1' + path, json={'revision': 1, 'label': 'New label'})
    assert changed.status_code == 200
    before = export(client, base)
    r = client.delete('/api/v1' + path + '?revision=1')
    assert r.status_code == 409, r.text
    assert r.json()['details'] == {'current_revision': 2}
    assert export(client, base) == before
    assert client.get('/api/v1/files/' + unused['id']).json() == unused


@pytest.mark.parametrize('guarded', [False, True])
def test_explicit_empty_team_delete_cleans_scoped_orphans_preserves_lab_members_and_blob_owners(client, guarded):
    base, lab_obj = lab(client)
    path, obj = team(client, base, members=[{'student_id': 'literal-01', 'name': 'Synthetic name'}],
                     membership_complete=True, notes='Explicitly removed team notes')
    unused = upload(client, base, team_id=obj['id'])
    other_path, other_team = team(client, base, label='Other team')
    other_file = upload(client, base, team_id=other_team['id'])
    shared = upload(client, base)
    other_lab, _ = lab(client, 'Other lab')
    external = upload(client, other_lab)
    assert all(f['sha256'] == unused['sha256'] for f in (other_file, shared, external))
    ex = exercise(client, base)
    suffix = '?revision=1' if guarded else ''
    r = client.delete('/api/v1' + path + suffix)
    assert r.status_code == 204, r.text
    assert client.get('/api/v1' + path).status_code == 404
    assert client.delete('/api/v1' + path + suffix).status_code == 404
    assert client.get('/api/v1/files/' + unused['id']).status_code == 404
    assert client.get('/api/v1' + base).json() == lab_obj
    assert client.get('/api/v1' + other_path).json() == other_team
    assert client.get('/api/v1' + base + '/exercises/' + ex['id']).json() == ex
    for f in (other_file, shared, external):
        assert client.get('/api/v1/files/' + f['id']).json() == f
        assert client.get('/api/v1/files/' + f['id'] + '/download').content == b'synthetic bytes'
    assert client.app.state.catalog.blobs.read(unused['sha256'], unused['size']) == b'synthetic bytes'
    assert impact(client, base)['dependencies'] == deps(exercises=1, teams=1)


def test_stale_empty_team_revision_never_cleans_orphan_then_current_revision_succeeds(client):
    base, _ = lab(client)
    path, obj = team(client, base)
    unused = upload(client, base, team_id=obj['id'])
    assert client.patch('/api/v1' + path, json={'revision': 1, 'notes': 'New notes'}).status_code == 200
    before = export(client, base)
    r = client.delete('/api/v1' + path + '?revision=1')
    assert r.status_code == 409, r.text
    assert r.json()['details'] == {'current_revision': 2}
    assert export(client, base) == before
    assert client.delete('/api/v1' + path + '?revision=2').status_code == 204
    assert client.get('/api/v1/files/' + unused['id']).status_code == 404


@pytest.mark.parametrize('method', ['delete', 'impact'])
def test_team_real_dependency_diagnostics_are_scoped_and_preserve_history(client, method):
    base, _, ex, obj, *_ = populated(client)
    populated(client, 'Other lab with same dependency types')
    _, other = team(client, base, label='Other team in same lab')
    create(client, base + '/teams/' + other['id'] + '/evidence',
           {'title': 'Other evidence', 'kind': 'text', 'text': 'Inert', 'exercise_id': ex['id']})
    path = base + '/teams/' + obj['id']
    unused = upload(client, base, 'literal unused-é.txt', team_id=obj['id'])
    before = export(client, base)
    expected = {'dependencies': deps(files=1, submissions=1, assessments=1, assessment_history=2, evidence=1),
                'unreferenced_files': [{'id': unused['id'], 'filename': unused['filename']}],
                'unreferenced_files_total': 1}
    if method == 'delete':
        r = client.delete('/api/v1' + path + '?revision=1')
        assert r.status_code == 409, r.text
        assert r.json()['code'] == 'conflict'
        assert r.json()['details'] == expected
    else:
        assert legacy_details(impact(client, path)) == expected
    assert export(client, base) == before
    assert client.get('/api/v1' + path).json() == obj


@pytest.mark.parametrize('blocker', ['evidence', 'assessments', 'submissions'])
def test_each_real_team_blocker_independently_preserves_orphan_metadata(client, blocker):
    base, _ = lab(client)
    path, obj = team(client, base)
    unused = upload(client, base, team_id=obj['id'])
    if blocker == 'submissions':
        r = client.post('/api/v1' + path + '/submissions', files={'file': ('student.zip', zip_bytes())})
        assert r.status_code == 201
        expected = deps(files=1, submissions=1)
    else:
        ex = exercise(client, base)
        if blocker == 'evidence':
            create(client, path + '/evidence', {'title': 'Text evidence', 'kind': 'text',
                   'text': 'Inert text', 'exercise_id': ex['id']})
            expected = deps(evidence=1)
        else:
            r = client.put('/api/v1' + path + '/assessments/' + ex['id'],
                           json={'revision': 0, 'rubric_revision': 1, 'notes': 'Draft'})
            assert r.status_code == 200
            expected = deps(assessments=1, assessment_history=1)
    before = export(client, base)
    r = client.delete('/api/v1' + path)
    assert r.status_code == 409, r.text
    assert r.json()['details'] == {'dependencies': expected,
        'unreferenced_files': [{'id': unused['id'], 'filename': unused['filename']}], 'unreferenced_files_total': 1}
    assert export(client, base) == before


@pytest.mark.parametrize('association', ['materials', 'submissions', 'evidence'])
def test_team_file_references_are_global_not_limited_to_same_team(client, association):
    base, _ = lab(client)
    path, obj = team(client, base)
    other_path, _ = team(client, base, label='Other reference owner')
    f = upload(client, base)
    if association == 'materials':
        create(client, base + '/materials', {'title': 'Handout', 'role': 'handout', 'file_id': f['id']})
    elif association == 'evidence':
        ex = exercise(client, base)
        create(client, other_path + '/evidence', {'title': 'Shared evidence', 'kind': 'file',
               'file_id': f['id'], 'exercise_id': ex['id']})
    else:
        r = client.post('/api/v1' + other_path + '/submissions', files={'file': ('student.zip', zip_bytes())})
        assert r.status_code == 201
        f = client.get('/api/v1/files/' + r.json()['file_id']).json()
    # Represent existing FK-valid associations independently of today's API
    # creation policy: cleanup must protect references globally, not by owner.
    catalog = client.app.state.catalog
    with catalog.db.connect(write=True) as conn:
        f['team_id'] = obj['id']
        catalog.db.save(conn, 'files', f, COLUMNS['files'], update=True)
    unused = upload(client, base, team_id=obj['id'])
    before = export(client, base)
    expected = {'dependencies': deps(files=1),
                'unreferenced_files': [{'id': unused['id'], 'filename': unused['filename']}],
                'unreferenced_files_total': 1}
    r = client.delete('/api/v1' + path + '?revision=1')
    assert r.status_code == 409, r.text
    assert r.json()['details'] == expected
    # The legacy restrictive delete retains these exact diagnostics. A confirmed
    # cascade cannot remove team-owned files beneath surviving global references.
    assert client.get('/api/v1' + path + '/deletion-impact').status_code == 409
    assert client.delete('/api/v1' + path, params={'cascade': 'true', 'confirmation_token': '0' * 64}).status_code == 409
    assert export(client, base) == before


def test_team_orphan_preview_is_bounded_stable_and_cleanup_removes_all_metadata(client):
    base, _ = lab(client)
    path, obj = team(client, base)
    files = [upload(client, base, f'literal-é-{n}.txt', team_id=obj['id']) for n in range(53)]
    assert legacy_details(impact(client, path)) == {'dependencies': [],
        'unreferenced_files': [{'id': f['id'], 'filename': f['filename']} for f in files[:50]],
        'unreferenced_files_total': 53}
    assert client.delete('/api/v1' + path + '?revision=1').status_code == 204
    assert client.get('/api/v1' + path).status_code == 404
    for f in files:
        assert client.get('/api/v1/files/' + f['id']).status_code == 404
    assert client.app.state.catalog.blobs.read(files[0]['sha256'], files[0]['size']) == b'synthetic bytes'


@pytest.mark.parametrize('failure_table', ['teams', 'files'])
def test_team_cleanup_failure_rolls_back_all_metadata_and_sanitizes_storage_error(client, failure_table):
    base, _ = lab(client)
    path, obj = team(client, base)
    files = [upload(client, base, f'orphan-{n}.txt', team_id=obj['id']) for n in range(53)]
    before = export(client, base)
    catalog = client.app.state.catalog
    with catalog.db.connect(write=True) as conn:
        conn.execute(f"CREATE TRIGGER reject_cleanup AFTER DELETE ON {failure_table} BEGIN SELECT RAISE(ABORT,'private synthetic failure'); END")
    r = client.delete('/api/v1' + path + '?revision=1')
    assert r.status_code == 500, r.text
    assert r.json() == {'code': 'storage_error', 'message': 'Storage operation failed', 'details': None}
    assert export(client, base) == before
    assert impact(client, path)['unreferenced_files_total'] == 53
    for f in files:
        assert client.get('/api/v1/files/' + f['id']).json() == f
    assert catalog.blobs.read(files[0]['sha256'], files[0]['size']) == b'synthetic bytes'


def test_team_missing_and_wrong_lab_precede_revision_without_dependency_leaks(client):
    base, _, _, obj, *_ = populated(client)
    other, _ = lab(client, 'Wrong lab')
    before = export(client, base)
    paths = [other + '/teams/' + obj['id'], '/labs/missing/teams/' + obj['id'], base + '/teams/missing']
    for path in paths:
        for r in (client.delete('/api/v1' + path + '?revision=99'), client.get('/api/v1' + path + '/deletion-impact')):
            assert r.status_code == 404, r.text
            assert r.json()['details'] is None
    assert export(client, base) == before


def test_team_delete_and_impact_require_authentication_without_cleanup(client):
    base, _ = lab(client)
    path, obj = team(client, base)
    upload(client, base, team_id=obj['id'])
    before = export(client, base)
    auth = client.headers.pop('Authorization')
    try:
        assert client.delete('/api/v1' + path + '?revision=1').status_code == 401
        assert client.get('/api/v1' + path + '/deletion-impact').status_code == 401
    finally:
        client.headers['Authorization'] = auth
    assert export(client, base) == before


def test_team_delete_waits_for_committed_revision_without_cleaning(client, monkeypatch):
    base, _ = lab(client)
    path, obj = team(client, base)
    upload(client, base, team_id=obj['id'])
    catalog = client.app.state.catalog
    original_connect = catalog.db.connect
    started = Event()

    @contextmanager
    def observing_connect(write=False):
        if write:
            started.set()
        with original_connect(write=write) as conn:
            yield conn

    with ThreadPoolExecutor(max_workers=1) as pool:
        with original_connect(write=True) as conn:
            obj['revision'] = 2
            catalog.db.save(conn, 'teams', obj, COLUMNS['teams'], update=True)
            monkeypatch.setattr(catalog.db, 'connect', observing_connect)
            waiting = pool.submit(client.delete, '/api/v1' + path + '?revision=1')
            assert started.wait(10), 'Delete did not attempt write transaction'
        r = waiting.result(timeout=10)
    assert r.status_code == 409, r.text
    assert r.json()['details'] == {'current_revision': 2}
    assert impact(client, path)['unreferenced_files_total'] == 1


def test_team_delete_rechecks_concurrent_committed_file_reference(client, monkeypatch):
    base, lab_obj = lab(client)
    path, obj = team(client, base)
    f = upload(client, base, team_id=obj['id'])
    catalog = client.app.state.catalog
    original_connect = catalog.db.connect
    started = Event()

    @contextmanager
    def observing_connect(write=False):
        if write:
            started.set()
        with original_connect(write=write) as conn:
            yield conn

    with ThreadPoolExecutor(max_workers=1) as pool:
        with original_connect(write=True) as conn:
            material = {'id': 'synthetic-concurrent-material', 'lab_id': lab_obj['id'],
                        'exercise_id': None, 'file_id': f['id'], 'title': 'Handout', 'role': 'handout',
                        'description': '', 'revision': 1, 'updated_at': None}
            catalog.db.save(conn, 'materials', material, COLUMNS['materials'])
            monkeypatch.setattr(catalog.db, 'connect', observing_connect)
            waiting = pool.submit(client.delete, '/api/v1' + path + '?revision=1')
            assert started.wait(10), 'Delete did not attempt write transaction'
        r = waiting.result(timeout=10)
    assert r.status_code == 409, r.text
    assert r.json()['details'] == {'dependencies': deps(files=1), 'unreferenced_files': [], 'unreferenced_files_total': 0}
    assert client.get('/api/v1/files/' + f['id']).json() == f
    assert client.get('/api/v1' + path).json() == obj


def test_team_impact_has_coherent_snapshot_while_upload_commits(client, monkeypatch):
    base, _ = lab(client)
    path, obj = team(client, base)
    catalog = client.app.state.catalog
    original_get = catalog.get
    paused, resume = Event(), Event()

    def pause_after_team_read(conn, table, identifier, lab_id=None):
        result = original_get(conn, table, identifier, lab_id)
        if table == 'teams' and identifier == obj['id'] and not paused.is_set():
            paused.set()
            assert resume.wait(10), 'Read snapshot was not released'
        return result

    monkeypatch.setattr(catalog, 'get', pause_after_team_read)
    with ThreadPoolExecutor(max_workers=1) as pool:
        waiting = pool.submit(client.get, '/api/v1' + path + '/deletion-impact')
        try:
            assert paused.wait(10), 'Impact did not validate team ownership'
            f = upload(client, base, team_id=obj['id'])
        finally:
            resume.set()
        r = waiting.result(timeout=10)
    assert r.status_code == 200, r.text
    assert legacy_details(r.json()) == EMPTY
    assert legacy_details(impact(client, path)) == {'dependencies': [],
        'unreferenced_files': [{'id': f['id'], 'filename': f['filename']}], 'unreferenced_files_total': 1}


def test_concurrent_team_deletes_have_one_success_and_one_not_found(client):
    base, _ = lab(client)
    path, obj = team(client, base)
    f = upload(client, base, team_id=obj['id'])
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: client.delete('/api/v1' + path + '?revision=1').status_code, range(2))) == [204, 404]
    assert client.get('/api/v1/files/' + f['id']).status_code == 404


def test_team_openapi_documents_revision_real_dependencies_and_metadata_only_cleanup(client):
    paths = client.get('/openapi.json').json()['paths']
    delete = paths['/api/v1/labs/{lab_id}/teams/{team_id}']['delete']
    revision = next(p for p in delete['parameters'] if p['name'] == 'revision')
    assert revision['required'] is False
    assert any(s.get('minimum') == 1 for s in revision['schema']['anyOf'])
    description = delete['description'].lower()
    for phrase in ('team', 'metadata', 'blob', 'submissions', 'assessments', 'assessment_history', 'evidence', 'members', 'notes'):
        assert phrase in description
    operation = paths['/api/v1/labs/{lab_id}/teams/{team_id}/deletion-impact']['get']
    assert operation['security']
    assert operation['responses']['200']['content']['application/json']['schema'] == {'$ref': '#/components/schemas/DeletionImpact'}
