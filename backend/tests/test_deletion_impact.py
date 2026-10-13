"""Deletion diagnostics and upload cleanup against synthetic HTTP/SQLite only."""
from concurrent.futures import ThreadPoolExecutor
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from lab_catalog.api import create_app
from lab_catalog.service import COLUMNS


EMPTY = {'dependencies': [], 'unreferenced_files': [], 'unreferenced_files_total': 0}


@pytest.fixture
def client(tmp_path):
    root = tmp_path / 'impact-state'
    app = create_app(root, ['testserver'])
    with TestClient(app) as c:
        c.headers['Authorization'] = 'Bearer ' + (root / 'operator-token').read_text().strip()
        yield c


def create(c, path, body):
    r = c.post('/api/v1' + path, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def lab(c, title='Synthetic lab'):
    obj = create(c, '/labs', {'title': title})
    return '/labs/' + obj['id'], obj


def exercise(c, base):
    return create(c, base + '/exercises', {'title': 'Synthetic exercise', 'max_points': '3'})


def upload(c, base, filename='literal-é.txt', data=b'synthetic bytes', team_id=None):
    r = c.post('/api/v1' + base + '/files', files={'file': (filename, data)},
               data={'team_id': team_id} if team_id else {})
    assert r.status_code == 201, r.text
    return r.json()


def zip_bytes():
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        z.writestr(zipfile.ZipInfo('student.txt', (2020, 1, 1, 0, 0, 0)), b'inert student original')
    return out.getvalue()


def populated(c, title='Synthetic populated'):
    base, obj = lab(c, title)
    ex = exercise(c, base)
    team = create(c, base + '/teams', {'label': 'Synthetic team'})
    f = upload(c, base)
    unused = upload(c, base, 'literal unused-é.txt')
    create(c, base + '/materials', {'title': 'Handout', 'role': 'handout',
                                  'file_id': f['id'], 'exercise_id': ex['id']})
    r = c.post('/api/v1' + base + '/teams/' + team['id'] + '/submissions',
               files={'file': ('student.zip', zip_bytes(), 'application/zip')})
    assert r.status_code == 201, r.text
    sub = r.json()
    evidence_path = base + '/teams/' + team['id'] + '/evidence'
    create(c, evidence_path, {'title': 'File evidence', 'kind': 'file',
                             'exercise_id': ex['id'], 'file_id': f['id'], 'submission_id': sub['id']})
    grade = '/api/v1' + base + '/teams/' + team['id'] + '/assessments/' + ex['id']
    for revision in (0, 1):
        r = c.put(grade, json={'revision': revision, 'rubric_revision': 1,
                             'status': 'final', 'score': '2', 'submission_id': sub['id'], 'notes': str(revision)})
        assert r.status_code == 200, r.text
    return base, obj, ex, team, f, unused, sub


def impact(c, path):
    r = c.get('/api/v1' + path + '/deletion-impact')
    assert r.status_code == 200, r.text
    return r.json()


def legacy_details(result):
    """The additive confirmed-delete preview does not change legacy blockers."""
    return {key: result[key] for key in EMPTY}


def deps(**counts):
    return [{'kind': kind, 'count': count} for kind, count in counts.items() if count]


@pytest.mark.parametrize('kind', ['lab', 'exercise'])
@pytest.mark.parametrize('method', ['delete', 'impact'])
def test_actual_dependency_counts_are_scoped_preserve_all_records(client, kind, method):
    base, obj, ex, _, _, unused, _ = populated(client)
    populated(client, 'Unrelated owner with same dependency types')
    path = base if kind == 'lab' else base + '/exercises/' + ex['id']
    before = client.get('/api/v1' + base + '/export').json()
    if method == 'delete':
        r = client.delete('/api/v1' + path + '?revision=1')
        assert r.status_code == 409, r.text
        assert r.json()['code'] == 'conflict'
        assert 'dependents' in r.json()['message'] and 'archive instead' in r.json()['message']
        result = r.json()['details']
    else:
        result = legacy_details(impact(client, path))
    expected = deps(exercises=1, teams=1, files=2, materials=1, submissions=1,
                    assessments=1, assessment_history=2, evidence=1) if kind == 'lab' else deps(
                    materials=1, assessments=1, assessment_history=2, evidence=1)
    assert result == {'dependencies': expected,
                      'unreferenced_files': [{'id': unused['id'], 'filename': unused['filename']}] if kind == 'lab' else [],
                      'unreferenced_files_total': 1 if kind == 'lab' else 0}
    assert client.get('/api/v1' + base + '/export').json() == before
    assert client.get('/api/v1' + base).json() == obj


@pytest.mark.parametrize('kind', ['lab', 'exercise'])
def test_empty_deletion_impact(client, kind):
    base, _ = lab(client)
    path = base if kind == 'lab' else base + '/exercises/' + exercise(client, base)['id']
    assert legacy_details(impact(client, path)) == EMPTY


def test_exercise_has_no_direct_file_or_team_dependencies(client):
    base, _ = lab(client)
    ex = exercise(client, base)
    team = create(client, base + '/teams', {'label': 'Team'})
    upload(client, base, team_id=team['id'])
    path = base + '/exercises/' + ex['id']
    assert legacy_details(impact(client, path)) == EMPTY
    assert client.delete('/api/v1' + path + '?revision=1').status_code == 204
    assert client.get('/api/v1' + path).status_code == 404


@pytest.mark.parametrize('guarded', [False, True])
def test_lab_delete_cleans_only_orphan_metadata_without_second_delete(client, guarded):
    base, _ = lab(client)
    f = upload(client, base, 'gpgpu')
    other, _ = lab(client, 'Other owner of identical blob')
    shared = upload(client, other, 'other-literal-name.txt')
    assert shared['sha256'] == f['sha256']
    suffix = '?revision=1' if guarded else ''
    assert legacy_details(impact(client, base)) == {'dependencies': [],
        'unreferenced_files': [{'id': f['id'], 'filename': 'gpgpu'}], 'unreferenced_files_total': 1}
    assert client.delete('/api/v1' + base + suffix).status_code == 204
    assert client.get('/api/v1' + base).status_code == 404
    assert client.get('/api/v1/files/' + f['id']).status_code == 404
    assert client.get('/api/v1/files/' + shared['id']).json() == shared
    assert client.get('/api/v1/files/' + shared['id'] + '/download').content == b'synthetic bytes'
    assert client.app.state.catalog.blobs.read(f['sha256'], f['size']) == b'synthetic bytes'


def test_unreferenced_files_are_bounded_stable_with_full_total(client):
    base, _, _, _, _, unused, _ = populated(client)
    files = [unused] + [upload(client, base, f'literal-{n}.txt') for n in range(52)]
    expected_files = [{'id': f['id'], 'filename': f['filename']} for f in files[:50]]
    result = impact(client, base)
    assert result['unreferenced_files'] == expected_files
    assert result['unreferenced_files_total'] == 53
    assert result['dependencies'] == deps(exercises=1, teams=1, files=2, materials=1,
        submissions=1, assessments=1, assessment_history=2, evidence=1)
    assert client.delete('/api/v1' + base).json()['details'] == legacy_details(result)


@pytest.mark.parametrize('kind', ['lab', 'exercise'])
def test_revision_conflicts_do_not_disclose_dependency_details(client, kind):
    base, _, ex, *_ = populated(client)
    path = base if kind == 'lab' else base + '/exercises/' + ex['id']
    assert client.patch('/api/v1' + path, json={'revision': 1, 'title': 'Changed'}).status_code == 200
    r = client.delete('/api/v1' + path + '?revision=1')
    assert r.status_code == 409
    assert r.json()['details'] == {'current_revision': 2}


@pytest.mark.parametrize('resource', ['lab', 'exercise', 'file'])
def test_missing_or_wrong_owner_is_not_found_without_details(client, resource):
    base, obj, ex, _, f, *_ = populated(client)
    other, _ = lab(client, 'Other owner')
    if resource == 'lab':
        paths = ['/labs/missing']
    else:
        collection, identifier = ('exercises', ex['id']) if resource == 'exercise' else ('files', f['id'])
        paths = [other + '/' + collection + '/' + identifier,
                 '/labs/missing/' + collection + '/' + identifier,
                 base + '/' + collection + '/missing']
    for path in paths:
        r = client.delete('/api/v1' + path + ('?revision=99' if resource != 'file' else ''))
        assert r.status_code == 404, r.text
        assert r.json()['details'] is None
        if resource != 'file':
            r = client.get('/api/v1' + path + '/deletion-impact')
            assert r.status_code == 404, r.text
            assert r.json()['details'] is None
    assert client.get('/api/v1' + base).json() == obj


@pytest.mark.parametrize('resource', ['lab', 'exercise', 'file'])
def test_new_operations_require_authentication(client, resource):
    base, _, ex, _, _, unused, _ = populated(client)
    path = base if resource == 'lab' else base + ('/exercises/' + ex['id'] if resource == 'exercise' else '/files/' + unused['id'])
    before = client.get('/api/v1' + base + '/export').json()
    auth = client.headers.pop('Authorization')
    assert client.delete('/api/v1' + path).status_code == 401
    if resource != 'file':
        assert client.get('/api/v1' + path + '/deletion-impact').status_code == 401
    client.headers['Authorization'] = auth
    assert client.get('/api/v1' + base + '/export').json() == before


def test_referenced_file_reports_actual_counts_and_preserves_original_history(client):
    base, _, _, _, f, _, sub = populated(client)
    before = client.get('/api/v1' + base + '/export').json()
    r = client.delete('/api/v1' + base + '/files/' + f['id'])
    assert r.status_code == 409, r.text
    assert 'dependents' in r.json()['message']
    assert r.json()['details']['dependencies'] == deps(materials=1, evidence=1)
    r = client.delete('/api/v1' + base + '/files/' + sub['file_id'])
    assert r.status_code == 409, r.text
    assert r.json()['details']['dependencies'] == deps(submissions=1)
    assert client.get('/api/v1' + base + '/export').json() == before
    assert client.get('/api/v1/files/' + f['id'] + '/download').content == b'synthetic bytes'
    assert client.get('/api/v1/files/' + sub['file_id'] + '/download').content == zip_bytes()


@pytest.mark.parametrize('reference', ['materials', 'evidence'])
def test_each_file_association_independently_blocks_cleanup(client, reference):
    base, _ = lab(client)
    ex = exercise(client, base)
    f = upload(client, base)
    if reference == 'materials':
        create(client, base + '/materials', {'title': 'Handout', 'role': 'handout', 'file_id': f['id']})
    else:
        team = create(client, base + '/teams', {'label': 'Team'})
        create(client, base + '/teams/' + team['id'] + '/evidence',
            {'title': 'Evidence', 'kind': 'file', 'exercise_id': ex['id'], 'file_id': f['id']})
    r = client.delete('/api/v1' + base + '/files/' + f['id'])
    assert r.status_code == 409
    assert r.json()['details']['dependencies'] == deps(**{reference: 1})
    assert impact(client, base)['unreferenced_files_total'] == 0


@pytest.mark.parametrize('shared', [False, True])
def test_metadata_cleanup_keeps_blob_bytes_even_when_no_metadata_remains(client, shared):
    base, _ = lab(client)
    f = upload(client, base)
    other, _ = lab(client, 'Other blob owner')
    preserved = upload(client, other, 'shared.txt') if shared else None
    if preserved:
        assert preserved['sha256'] == f['sha256']
    blob_store = client.app.state.catalog.blobs
    assert client.delete('/api/v1' + base + '/files/' + f['id']).status_code == 204
    assert client.get('/api/v1/files/' + f['id']).status_code == 404
    assert client.get('/api/v1/files/' + f['id'] + '/download').status_code == 404
    assert client.delete('/api/v1' + base + '/files/' + f['id']).status_code == 404
    assert blob_store.read(f['sha256'], f['size']) == b'synthetic bytes'
    if preserved:
        assert client.get('/api/v1/files/' + preserved['id']).json() == preserved
        assert client.get('/api/v1/files/' + preserved['id'] + '/download').content == b'synthetic bytes'


def test_unused_team_file_can_be_removed_without_deleting_team(client):
    base, _ = lab(client)
    team = create(client, base + '/teams', {'label': 'Team'})
    f = upload(client, base, team_id=team['id'])
    assert impact(client, base)['unreferenced_files_total'] == 1
    assert client.delete('/api/v1' + base + '/files/' + f['id']).status_code == 204
    assert client.get('/api/v1/files/' + f['id']).status_code == 404
    assert client.get('/api/v1' + base + '/teams/' + team['id']).json() == team


def test_failed_metadata_delete_rolls_back_counts_and_preserves_blob(client):
    base, _ = lab(client)
    f = upload(client, base)
    catalog = client.app.state.catalog
    before = impact(client, base)
    with catalog.db.connect(write=True) as conn:
        conn.execute("CREATE TRIGGER fail_metadata_delete AFTER DELETE ON files BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    r = client.delete('/api/v1' + base + '/files/' + f['id'])
    assert r.status_code == 500, r.text
    assert r.json()['code'] == 'storage_error'
    assert impact(client, base) == before
    assert client.get('/api/v1/files/' + f['id']).json() == f
    assert catalog.blobs.read(f['sha256'], f['size']) == b'synthetic bytes'


def test_dependency_check_observes_committed_association_inside_delete_transaction(client):
    base, obj = lab(client)
    f = upload(client, base)
    catalog = client.app.state.catalog
    with ThreadPoolExecutor(max_workers=1) as pool:
        with catalog.db.connect(write=True) as conn:
            material = {'id': 'literal-material', 'lab_id': obj['id'], 'exercise_id': None,
                        'file_id': f['id'], 'title': 'Handout', 'role': 'handout', 'description': '',
                        'revision': 1, 'updated_at': None}
            catalog.db.save(conn, 'materials', material, COLUMNS['materials'])
            waiting = pool.submit(client.delete, '/api/v1' + base + '/files/' + f['id'])
        r = waiting.result(timeout=10)
    assert r.status_code == 409, r.text
    assert r.json()['details']['dependencies'] == deps(materials=1)
    assert client.get('/api/v1/files/' + f['id']).json() == f


def test_openapi_documents_metadata_only_cleanup_and_read_only_impacts(client):
    paths = client.get('/openapi.json').json()['paths']
    operation = paths['/api/v1/labs/{lab_id}/files/{file_id}']['delete']
    description = operation['description'].lower()
    for phrase in ('metadata', 'unreferenced', 'blob', 'materials', 'submissions', 'evidence'):
        assert phrase in description
    assert '409' in operation['responses'] and '404' in operation['responses']
    assert not any(p['name'] == 'revision' for p in operation['parameters'])
    for path in ('/api/v1/labs/{lab_id}/deletion-impact', '/api/v1/labs/{lab_id}/exercises/{exercise_id}/deletion-impact'):
        operation = paths[path]['get']
        assert operation['security']
        assert operation['responses']['200']['content']['application/json']['schema']
    assert '/api/v1/files/{file_id}' in paths


def test_file_counts_include_every_actual_association(client):
    base, _, ex, team, f, *_ = populated(client)
    create(client, base + '/materials', {'title': 'Second handout', 'role': 'handout', 'file_id': f['id']})
    create(client, base + '/teams/' + team['id'] + '/evidence',
           {'title': 'Second evidence', 'kind': 'file', 'exercise_id': ex['id'], 'file_id': f['id']})
    r = client.delete('/api/v1' + base + '/files/' + f['id'])
    assert r.status_code == 409
    assert r.json()['details']['dependencies'] == deps(materials=2, evidence=2)


def test_exercise_counts_exclude_other_exercise_in_same_lab(client):
    base, _, ex, team, *_ = populated(client)
    other = exercise(client, base)
    create(client, base + '/teams/' + team['id'] + '/evidence',
           {'title': 'Other evidence', 'kind': 'text', 'text': 'Inert', 'exercise_id': other['id']})
    grade = '/api/v1' + base + '/teams/' + team['id'] + '/assessments/' + other['id']
    assert client.put(grade, json={'revision': 0, 'rubric_revision': 1, 'notes': 'Other grade'}).status_code == 200
    result = impact(client, base + '/exercises/' + ex['id'])
    assert result['dependencies'] == deps(materials=1, assessments=1, assessment_history=2, evidence=1)


def test_read_impact_uses_coherent_snapshot_while_upload_commits(client, monkeypatch):
    from threading import Event
    base, obj = lab(client)
    catalog = client.app.state.catalog
    original_get = catalog.get
    paused, resume = Event(), Event()

    def pause_after_ownership_read(conn, table, identifier, lab_id=None):
        result = original_get(conn, table, identifier, lab_id)
        if table == 'labs' and identifier == obj['id'] and not paused.is_set():
            paused.set()
            assert resume.wait(10), 'Concurrent upload did not release impact read'
        return result

    monkeypatch.setattr(catalog, 'get', pause_after_ownership_read)
    with ThreadPoolExecutor(max_workers=1) as pool:
        waiting = pool.submit(client.get, '/api/v1' + base + '/deletion-impact')
        try:
            assert paused.wait(10), 'Impact did not validate ownership'
            f = upload(client, base)
        finally:
            resume.set()
        r = waiting.result(timeout=10)
    assert r.status_code == 200
    assert legacy_details(r.json()) == EMPTY
    assert legacy_details(impact(client, base)) == {'dependencies': [],
        'unreferenced_files': [{'id': f['id'], 'filename': f['filename']}], 'unreferenced_files_total': 1}


def test_concurrent_metadata_cleanup_has_one_success_and_one_not_found(client):
    base, _ = lab(client)
    f = upload(client, base)
    path = '/api/v1' + base + '/files/' + f['id']
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: client.delete(path).status_code, range(2))) == [204, 404]
    assert client.get('/api/v1/files/' + f['id']).status_code == 404
    assert legacy_details(impact(client, base)) == EMPTY


@pytest.mark.parametrize('blocker', ['exercises', 'teams', 'materials'])
def test_real_lab_blocker_never_cleans_orphan_metadata(client, blocker):
    base, _ = lab(client)
    unused = upload(client, base, 'invisible orphan.txt')
    if blocker == 'exercises':
        exercise(client, base)
    elif blocker == 'teams':
        create(client, base + '/teams', {'label': 'Team'})
    else:
        f = upload(client, base, 'referenced.txt')
        create(client, base + '/materials', {'title': 'Handout', 'role': 'handout', 'file_id': f['id']})
    before = client.get('/api/v1' + base + '/export').json()
    r = client.delete('/api/v1' + base + '?revision=1')
    assert r.status_code == 409
    assert r.json()['details']['dependencies'] == deps(**({'files': 1, 'materials': 1} if blocker == 'materials' else {blocker: 1}))
    assert client.get('/api/v1' + base + '/export').json() == before
    assert client.get('/api/v1/files/' + unused['id']).json() == unused


@pytest.mark.parametrize('failure_table', ['labs', 'files'])
def test_lab_cleanup_failure_rolls_back_lab_and_all_orphan_metadata(client, failure_table):
    base, obj = lab(client)
    files = [upload(client, base, f'orphan-{n}.txt') for n in range(3)]
    catalog = client.app.state.catalog
    before = impact(client, base)
    with catalog.db.connect(write=True) as conn:
        conn.execute(f"CREATE TRIGGER reject_cleanup AFTER DELETE ON {failure_table} BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END")
    r = client.delete('/api/v1' + base + '?revision=1')
    assert r.status_code == 500, r.text
    assert r.json()['code'] == 'storage_error'
    assert client.get('/api/v1' + base).json() == obj
    assert impact(client, base) == before
    for f in files:
        assert client.get('/api/v1/files/' + f['id']).json() == f
        assert catalog.blobs.read(f['sha256'], f['size']) == b'synthetic bytes'


def test_auth_and_revision_precede_lab_orphan_cleanup(client):
    base, _ = lab(client)
    f = upload(client, base)
    assert client.patch('/api/v1' + base, json={'revision': 1, 'title': 'Revision two'}).status_code == 200
    before = client.get('/api/v1' + base + '/export').json()
    auth = client.headers.pop('Authorization')
    assert client.delete('/api/v1' + base + '?revision=2').status_code == 401
    client.headers['Authorization'] = auth
    r = client.delete('/api/v1' + base + '?revision=1')
    assert r.status_code == 409
    assert r.json()['details'] == {'current_revision': 2}
    assert client.get('/api/v1' + base + '/export').json() == before
    assert client.get('/api/v1/files/' + f['id']).json() == f
    assert client.delete('/api/v1' + base + '?revision=2').status_code == 204
    assert client.get('/api/v1' + base).status_code == 404
    assert client.get('/api/v1/files/' + f['id']).status_code == 404


def test_lab_cleanup_removes_all_orphans_not_just_impact_preview(client):
    base, _ = lab(client)
    files = [upload(client, base, f'orphan-{n}.txt') for n in range(53)]
    assert impact(client, base)['unreferenced_files_total'] == 53
    assert client.delete('/api/v1' + base).status_code == 204
    assert client.get('/api/v1' + base).status_code == 404
    for f in files:
        assert client.get('/api/v1/files/' + f['id']).status_code == 404
    assert client.app.state.catalog.blobs.read(files[0]['sha256'], files[0]['size']) == b'synthetic bytes'
