"""Confirmed catalog deletion, using only synthetic HTTP and SQLite state."""
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from lab_catalog.api import create_app
from test_deletion_impact import client, populated, create, exercise, upload, lab, impact


def snapshot(c):
    with c.app.state.catalog.db.connect() as db:
        return {t: [dict(r) for r in db.execute(f'SELECT * FROM {t} ORDER BY id')]
                for t in ('labs', 'teams', 'exercises', 'files', 'materials', 'submissions',
                          'evidence', 'assessments', 'assessment_history')}


def targets(c):
    base, obj, ex, team, f, unused, sub = populated(c)
    data = c.get('/api/v1' + base + '/export').json()
    return base, {
        'labs': base, 'teams': base + '/teams/' + team['id'],
        'exercises': base + '/exercises/' + ex['id'],
        'files': base + '/files/' + f['id'],
        'materials': base + '/materials/' + data['materials'][0]['id'],
        'submissions': base + '/teams/' + team['id'] + '/submissions/' + sub['id'],
        'evidence': base + '/teams/' + team['id'] + '/evidence/' + data['evidence'][0]['id'],
        'assessments': base + '/teams/' + team['id'] + '/assessments/' + ex['id'],
    }, (obj, ex, team, f, unused, sub)


def confirmed(c, path, preview=None, **params):
    preview = preview or impact(c, path)
    return c.delete('/api/v1' + path, params={'cascade': 'true',
        'confirmation_token': preview['confirmation_token'], **params})


@pytest.mark.parametrize('kind,expected', [
    ('labs', {'labs': 1, 'teams': 1, 'exercises': 1, 'files': 3, 'materials': 1,
              'submissions': 1, 'evidence': 1, 'assessments': 1, 'assessment_history': 2}),
    ('teams', {'teams': 1, 'files': 1, 'submissions': 1, 'evidence': 1,
               'assessments': 1, 'assessment_history': 2}),
    ('exercises', {'exercises': 1, 'materials': 1, 'evidence': 1, 'files': 1,
                   'assessments': 1, 'assessment_history': 2}),
    ('files', {'files': 1, 'materials': 1, 'evidence': 1}),
    ('materials', {'materials': 1}),
    ('submissions', {'submissions': 1, 'files': 1, 'evidence': 1,
                     'assessments': 1, 'assessment_history': 2}),
    ('evidence', {'evidence': 1}),
    ('assessments', {'assessments': 1, 'assessment_history': 2}),
])
def test_each_catalog_layer_has_exact_scoped_cascade(client, kind, expected):
    base, paths, (_, ex, team, f, _, sub) = targets(client)
    other, *_ = populated(client, 'Other owner')
    other_before = client.get('/api/v1' + other + '/export').json()
    before = snapshot(client)
    preview = impact(client, paths[kind])
    assert {x['kind']: x['count'] for x in preview['cascade_counts']} == expected
    assert len(preview['confirmation_token']) == 64
    assert preview == impact(client, paths[kind])
    assert snapshot(client) == before  # impact/cancel is strictly read-only
    r = confirmed(client, paths[kind], preview, **({'revision': 2 if kind == 'assessments' else 1} if kind not in ('files', 'submissions') else {}))
    assert r.status_code == 204, r.text
    after = snapshot(client)
    assert {t: len(before[t]) - len(after[t]) for t in before if len(before[t]) != len(after[t])} == expected
    assert client.get('/api/v1' + other + '/export').json() == other_before
    assert client.app.state.catalog.blobs.read(f['sha256'], f['size']) == b'synthetic bytes'
    if kind == 'assessments':
        assert client.get('/api/v1' + paths[kind]).json()['id'] is None
        assert client.get('/api/v1' + paths[kind] + '/history').json()['items'] == []
        assert len(client.get('/api/v1' + base + '/export').json()['evidence']) == 1
    if kind in ('teams', 'exercises', 'submissions', 'files', 'materials', 'evidence'):
        assert client.get('/api/v1' + base).status_code == 200


@pytest.mark.parametrize('kind', ['labs', 'teams', 'exercises', 'files', 'materials', 'submissions', 'evidence', 'assessments'])
def test_confirmation_is_required_validated_and_checked_without_writes(client, kind):
    _, paths, _ = targets(client)
    before = snapshot(client)
    for params in ({'cascade': 'true'}, {'cascade': 'true', 'confirmation_token': 'bad'},
                   {'cascade': 'true', 'confirmation_token': 'z' * 64}):
        assert client.delete('/api/v1' + paths[kind], params=params).status_code == 422
        assert snapshot(client) == before
    r = client.delete('/api/v1' + paths[kind], params={'cascade': 'true', 'confirmation_token': '0' * 64})
    assert r.status_code == 409 and r.json()['code'] == 'deletion_changed', r.text
    assert snapshot(client) == before


def test_submission_closure_includes_assessments_with_historical_link(client):
    base, paths, (_, ex, team, _, _, sub) = targets(client)
    grade = paths['assessments']
    r = client.put('/api/v1' + grade, json={'revision': 2, 'rubric_revision': 1, 'notes': 'unlinked now'})
    assert r.status_code == 200
    assert r.json()['submission_id'] is None
    preview = impact(client, paths['submissions'])
    assert dict((x['kind'], x['count']) for x in preview['cascade_counts'])['assessment_history'] == 3
    assert confirmed(client, paths['submissions'], preview).status_code == 204
    assert client.get('/api/v1/submissions/' + sub['id']).status_code == 404
    assert client.get('/api/v1' + grade).json()['id'] is None
    assert client.get('/api/v1' + grade + '/history').json()['total'] == 0


@pytest.mark.parametrize('kind', ['materials', 'evidence'])
def test_leaf_removes_only_globally_unreferenced_attachment(client, kind):
    base, paths, (_, ex, team, _, _, _) = targets(client)
    f = upload(client, base, 'exclusive.txt')
    path = paths[kind]
    assert client.patch('/api/v1' + path, json={'revision': 1, 'file_id': f['id']}).status_code == 200
    preview = impact(client, path)
    assert {'kind': 'files', 'count': 1} in preview['cascade_counts']
    assert confirmed(client, path, preview, revision=2).status_code == 204
    assert client.get('/api/v1/files/' + f['id']).status_code == 404
    assert client.app.state.catalog.blobs.read(f['sha256'], f['size']) == b'synthetic bytes'


@pytest.mark.parametrize('change', ['root', 'dependent', 'added', 'attachment'])
def test_changed_full_plan_fingerprint_conflicts_without_cleanup(client, change):
    base, paths, (_, ex, _, f, _, _) = targets(client)
    preview = impact(client, paths['labs'])
    if change == 'root':
        assert client.patch('/api/v1' + base, json={'revision': 1, 'title': 'changed'}).status_code == 200
    elif change == 'dependent':
        assert client.patch('/api/v1' + paths['materials'], json={'revision': 1, 'title': 'changed'}).status_code == 200
    elif change == 'attachment':
        with client.app.state.catalog.db.connect(write=True) as db:
            db.execute("UPDATE files SET data=json_set(data,'$.filename','changed.txt') WHERE id=?", (f['id'],))
    else:
        exercise(client, base)
    before = snapshot(client)
    r = confirmed(client, base, preview)
    assert r.status_code == 409 and r.json()['code'] == 'deletion_changed', r.text
    assert snapshot(client) == before


@pytest.mark.parametrize('table', ['assessment_history', 'evidence', 'assessments', 'materials', 'submissions', 'files', 'exercises', 'teams', 'labs'])
def test_trigger_failure_rolls_back_full_cascade(client, table):
    base, paths, _ = targets(client)
    preview = impact(client, base)
    with client.app.state.catalog.db.connect(write=True) as db:
        db.execute(f"CREATE TRIGGER synthetic_failure AFTER DELETE ON {table} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    before = snapshot(client)
    r = confirmed(client, base, preview)
    assert r.status_code == 500 and r.json()['code'] == 'storage_error', r.text
    assert snapshot(client) == before
    with pytest.raises(sqlite3.IntegrityError, match='immutable'):
        with client.app.state.catalog.db.connect(write=True) as db:
            db.execute('DELETE FROM assessment_history')


def test_populated_v2_migration_preserves_history_and_allows_only_planned_deletes(client):
    base, paths, (_, ex, team, _, _, _) = targets(client)
    catalog = client.app.state.catalog
    before = snapshot(client)
    with catalog.db.connect(write=True) as db:
        db.execute('DROP TRIGGER history_no_delete')
        db.execute("CREATE TRIGGER history_no_delete BEFORE DELETE ON assessment_history BEGIN SELECT RAISE(ABORT,'immutable assessment history'); END")
        db.execute('PRAGMA user_version=2')
    with TestClient(create_app(catalog.db.root, ['testserver'])) as restarted:
        restarted.headers.update(client.headers)
        assert snapshot(restarted) == before
        with restarted.app.state.catalog.db.connect() as db:
            assert db.execute('PRAGMA user_version').fetchone()[0] == 3
        for sql in ("UPDATE assessment_history SET data='{}'", 'DELETE FROM assessment_history'):
            with pytest.raises(sqlite3.IntegrityError, match='immutable'):
                with restarted.app.state.catalog.db.connect(write=True) as db:
                    db.execute(sql)
        raw = sqlite3.connect(catalog.db.path)
        try:
            with pytest.raises(sqlite3.DatabaseError):
                raw.execute('DELETE FROM assessment_history')
            raw.rollback()
        finally:
            raw.close()
        assert confirmed(restarted, paths['assessments']).status_code == 204
        assert restarted.get('/api/v1' + paths['assessments']).json()['revision'] == 0
    assert client.get('/api/v1' + paths['assessments'] + '/history').json()['total'] == 0


def test_team_cascade_retains_shared_lab_attachment_metadata(client):
    base, paths, (_, ex, team, _, _, _) = targets(client)
    shared = upload(client, base, 'lab-owned evidence.txt')
    create(client, base + '/teams/' + team['id'] + '/evidence',
           {'title': 'Shared upload', 'kind': 'file', 'file_id': shared['id'], 'exercise_id': ex['id']})
    preview = impact(client, paths['teams'])
    assert {x['kind']: x['count'] for x in preview['cascade_counts']}['files'] == 1
    assert confirmed(client, paths['teams'], preview).status_code == 204
    assert client.get('/api/v1/files/' + shared['id']).json() == shared


def test_file_cascade_induces_original_submission_and_historical_grade_closure(client):
    base, paths, (_, _, _, _, _, sub) = targets(client)
    assert client.put('/api/v1' + paths['assessments'], json={'revision': 2, 'rubric_revision': 1, 'notes': 'unlinked'}).status_code == 200
    path = base + '/files/' + sub['file_id']
    preview = impact(client, path)
    assert {x['kind']: x['count'] for x in preview['cascade_counts']} == {
        'files': 1, 'submissions': 1, 'evidence': 1, 'assessments': 1, 'assessment_history': 3}
    assert confirmed(client, path, preview).status_code == 204
    assert client.get('/api/v1/submissions/' + sub['id']).status_code == 404
    assert client.get('/api/v1' + paths['assessments']).json()['id'] is None
    assert client.get('/api/v1' + paths['materials']).status_code == 200


@pytest.mark.parametrize('kind', ['labs', 'teams', 'exercises'])
@pytest.mark.parametrize('variable_limit', [50, 500])
def test_cascade_all_rows_beyond_preview_and_sqlite_variable_limit(client, kind, monkeypatch, variable_limit):
    from contextlib import contextmanager
    base, paths, (obj, _, team, _, _, _) = targets(client)
    catalog = client.app.state.catalog
    with catalog.db.connect(write=True) as db:
        template = catalog.db.rows(db, 'evidence')[0]
        original_history = dict(db.execute('SELECT * FROM assessment_history LIMIT 1').fetchone())
        for n in range(1100):
            item = {**template, 'id': f'extra-evidence-{n}'}
            from lab_catalog.service import COLUMNS
            catalog.db.save(db, 'evidence', item, COLUMNS['evidence'])
            db.execute('INSERT INTO assessment_history VALUES(?,?,?)',
                       (f'extra-history-{n}', original_history['assessment_id'], original_history['data']))
    preview = impact(client, paths[kind])
    counts = {x['kind']: x['count'] for x in preview['cascade_counts']}
    assert counts['evidence'] == 1101 and counts['assessment_history'] == 1102
    original = catalog.db.connect

    @contextmanager
    def bounded_connection(write=False):
        with original(write=write) as db:
            db.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, variable_limit)
            yield db

    monkeypatch.setattr(catalog.db, 'connect', bounded_connection)
    assert confirmed(client, paths[kind], preview).status_code == 204
    with catalog.db.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM evidence').fetchone()[0] == 0
        assert db.execute('SELECT COUNT(*) FROM assessment_history').fetchone()[0] == 0


@pytest.mark.parametrize('kind', ['labs', 'teams', 'exercises', 'files', 'materials', 'submissions', 'evidence', 'assessments'])
def test_confirmed_routes_require_auth_and_scope_before_token_comparison(client, kind):
    base, paths, (_, ex, team, _, _, _) = targets(client)
    other, _ = lab(client, 'Other lab')
    before = snapshot(client)
    params = {'cascade': 'true', 'confirmation_token': '0' * 64}
    if kind != 'labs':
        wrong = paths[kind].replace(base, other, 1)
        r = client.delete('/api/v1' + wrong, params=params)
        assert r.status_code == 404 and r.json()['details'] is None
        assert client.get('/api/v1' + wrong + '/deletion-impact').status_code == 404
    if kind in ('evidence', 'submissions', 'assessments'):
        other_team = create(client, base + '/teams', {'label': 'Other team'})
        wrong = paths[kind].replace(team['id'], other_team['id'])
        assert client.delete('/api/v1' + wrong, params=params).status_code == 404
        assert client.get('/api/v1' + wrong + '/deletion-impact').status_code == 404
        before = snapshot(client)
    auth = client.headers.pop('Authorization')
    assert client.delete('/api/v1' + paths[kind], params=params).status_code == 401
    assert client.get('/api/v1' + paths[kind] + '/deletion-impact').status_code == 401
    client.headers['Authorization'] = auth
    if kind not in ('files', 'submissions'):
        r = client.delete('/api/v1' + paths[kind], params={**params, 'revision': 99})
        assert r.status_code == 409 and r.json()['details'] == {'current_revision': 2 if kind == 'assessments' else 1}
    assert snapshot(client) == before


@pytest.mark.parametrize('kind', ['labs', 'teams', 'exercises', 'files', 'materials', 'submissions', 'evidence'])
def test_historic_cross_lab_reference_never_deletes_other_owner(client, kind):
    base, paths, (_, _, _, f, _, sub) = targets(client)
    other, _ = lab(client, 'Other lab')
    foreign = upload(client, other)
    material = create(client, other + '/materials', {'title': 'Foreign handout', 'role': 'handout', 'file_id': foreign['id']})
    # Simulate historical FK-valid cross-lab metadata, not accepted by the API.
    with client.app.state.catalog.db.connect(write=True) as db:
        if kind in ('submissions', 'teams'):
            db.execute("UPDATE materials SET file_id=?,data=json_set(data,'$.file_id',?) WHERE id=?", (sub['file_id'], sub['file_id'], material['id']))
        else:
            db.execute("UPDATE materials SET file_id=?,data=json_set(data,'$.file_id',?) WHERE id=?", (f['id'], f['id'], material['id']))
    before = snapshot(client)
    r = client.get('/api/v1' + paths[kind] + '/deletion-impact')
    assert r.status_code == 409, r.text
    r = client.delete('/api/v1' + paths[kind], params={'cascade': 'true', 'confirmation_token': '0' * 64})
    assert r.status_code == 409, r.text
    assert snapshot(client) == before


def test_history_capability_cannot_remove_unplanned_history_or_update_any_history(client):
    base, paths, _ = targets(client)
    other, *_ = populated(client, 'Other owner')
    catalog = client.app.state.catalog
    with catalog.db.connect() as db:
        selected = db.execute('SELECT id FROM assessment_history ORDER BY rowid LIMIT 1').fetchone()[0]
        foreign = db.execute('SELECT id FROM assessment_history ORDER BY rowid DESC LIMIT 1').fetchone()[0]
    with catalog.db.connect(write=True) as db:
        with db.allow_history_deletion([selected]):
            for sql, args in [("UPDATE assessment_history SET data='{}' WHERE id=?", (selected,)),
                              ('DELETE FROM assessment_history WHERE id=?', (foreign,))]:
                with pytest.raises(sqlite3.IntegrityError, match='immutable'):
                    db.execute(sql, args)
            with catalog.db.connect() as second:
                assert second.execute('SELECT catalog_history_delete_allowed(?)', (selected,)).fetchone()[0] == 0
        with pytest.raises(sqlite3.IntegrityError, match='immutable'):
            db.execute('DELETE FROM assessment_history WHERE id=?', (selected,))


@pytest.mark.parametrize('change', ['revision', 'dependent'])
def test_waiting_confirmed_delete_rechecks_committed_state_inside_write_lock(client, monkeypatch, change):
    from concurrent.futures import ThreadPoolExecutor
    from contextlib import contextmanager
    from threading import Event
    base, paths, _ = targets(client)
    preview = impact(client, base)
    catalog = client.app.state.catalog
    original = catalog.db.connect
    entered = Event()

    @contextmanager
    def observed_connection(write=False):
        if write: entered.set()
        with original(write=write) as db:
            yield db

    monkeypatch.setattr(catalog.db, 'connect', observed_connection)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with original(write=True) as db:
            if change == 'revision':
                db.execute("UPDATE labs SET data=json_set(data,'$.revision',2) WHERE id=?", (base.rsplit('/', 1)[1],))
            else:
                db.execute("UPDATE evidence SET data=json_set(data,'$.text','concurrent correction')")
            entered.clear()
            pending = pool.submit(confirmed, client, base, preview, revision=1)
            assert entered.wait(10), 'Delete never competed for the write lock'
        before = snapshot(client)
        r = pending.result(timeout=10)
    assert r.status_code == 409, r.text
    if change == 'revision':
        assert r.json()['details'] == {'current_revision': 2}
    else:
        assert r.json()['code'] == 'deletion_changed'
    assert snapshot(client) == before


def test_submission_original_metadata_survives_any_remaining_reference(client):
    base, paths, (_, ex, team, _, _, sub) = targets(client)
    independent = create(client, base + '/teams/' + team['id'] + '/evidence',
        {'title': 'Original retained independently', 'kind': 'file', 'exercise_id': ex['id'], 'file_id': sub['file_id']})
    preview = impact(client, paths['submissions'])
    assert not any(x['kind'] == 'files' for x in preview['cascade_counts'])
    assert confirmed(client, paths['submissions'], preview).status_code == 204
    assert client.get('/api/v1/files/' + sub['file_id']).status_code == 200
    assert client.get('/api/v1' + base + '/teams/' + team['id'] + '/evidence/' + independent['id']).json() == independent


@pytest.mark.parametrize('kind', ['teams', 'exercises'])
def test_higher_layer_preserves_siblings_and_their_history(client, kind):
    base, paths, (_, ex, team, _, _, _) = targets(client)
    sibling_team = create(client, base + '/teams', {'label': 'Sibling team'})
    sibling_ex = exercise(client, base)
    grade = base + '/teams/' + sibling_team['id'] + '/assessments/' + sibling_ex['id']
    assert client.put('/api/v1' + grade, json={'revision': 0, 'rubric_revision': 1, 'notes': 'Sibling assessment'}).status_code == 200
    evidence = create(client, base + '/teams/' + sibling_team['id'] + '/evidence',
        {'title': 'Sibling evidence', 'kind': 'text', 'text': 'preserved', 'exercise_id': sibling_ex['id']})
    before_grade = client.get('/api/v1' + grade).json()
    before_history = client.get('/api/v1' + grade + '/history').json()
    assert confirmed(client, paths[kind]).status_code == 204
    assert client.get('/api/v1' + grade).json() == before_grade
    assert client.get('/api/v1' + grade + '/history').json() == before_history
    assert client.get('/api/v1' + base + '/teams/' + sibling_team['id'] + '/evidence/' + evidence['id']).json() == evidence
    assert client.get('/api/v1' + base + '/teams/' + sibling_team['id']).json() == sibling_team
    assert client.get('/api/v1' + base + '/exercises/' + sibling_ex['id']).json() == sibling_ex


def test_changed_history_is_in_confirmation_fingerprint(client):
    base, paths, _ = targets(client)
    preview = impact(client, paths['assessments'])
    with client.app.state.catalog.db.connect(write=True) as db:
        row = db.execute('SELECT * FROM assessment_history LIMIT 1').fetchone()
        obj = json.loads(row['data'])
        obj['notes'] = 'new history record'
        db.execute('INSERT INTO assessment_history VALUES(?,?,?)', ('new-history', row['assessment_id'], json.dumps(obj)))
    before = snapshot(client)
    r = confirmed(client, paths['assessments'], preview)
    assert r.status_code == 409 and r.json()['code'] == 'deletion_changed'
    assert snapshot(client) == before


def test_fingerprint_tracks_full_plan_beyond_preview_and_preview_has_full_total(client):
    base, paths, (_, _, team, _, _, _) = targets(client)
    files = [upload(client, base, f'orphan-{n}.txt', team_id=team['id']) for n in range(53)]
    preview = impact(client, paths['teams'])
    assert preview['unreferenced_files_total'] == 53
    assert len(preview['unreferenced_files']) == 50
    assert {x['kind']: x['count'] for x in preview['cascade_counts']}['files'] == 54
    with client.app.state.catalog.db.connect(write=True) as db:
        db.execute("UPDATE files SET data=json_set(data,'$.filename','last changed') WHERE id=?", (files[-1]['id'],))
    before = snapshot(client)
    r = confirmed(client, paths['teams'], preview)
    assert r.status_code == 409 and r.json()['code'] == 'deletion_changed'
    assert snapshot(client) == before
    assert confirmed(client, paths['teams']).status_code == 204
    for f in files:
        assert client.get('/api/v1/files/' + f['id']).status_code == 404


@pytest.mark.parametrize('kind', ['submissions', 'assessments'])
def test_new_delete_routes_default_to_restrictive_history_protection(client, kind):
    _, paths, _ = targets(client)
    before = snapshot(client)
    r = client.delete('/api/v1' + paths[kind])
    assert r.status_code == 409 and r.json()['code'] == 'conflict'
    assert snapshot(client) == before


def test_openapi_exposes_confirmation_and_metadata_retention_contract(client):
    paths = client.get('/openapi.json').json()['paths']
    resources = [
        '/api/v1/labs/{lab_id}', '/api/v1/labs/{lab_id}/exercises/{exercise_id}',
        '/api/v1/labs/{lab_id}/teams/{team_id}', '/api/v1/labs/{lab_id}/materials/{material_id}',
        '/api/v1/labs/{lab_id}/files/{file_id}',
        '/api/v1/labs/{lab_id}/teams/{team_id}/submissions/{submission_id}',
        '/api/v1/labs/{lab_id}/teams/{team_id}/evidence/{evidence_id}',
        '/api/v1/labs/{lab_id}/teams/{team_id}/assessments/{exercise_id}',
    ]
    for path in resources:
        op = paths[path]['delete']
        names = {p['name'] for p in op['parameters']}
        assert {'cascade', 'confirmation_token'} <= names
        assert ('revision' in names) == ('/files/' not in path and '/submissions/' not in path)
        desc = op['description'].lower()
        for phrase in ('cascade=true', 'confirmation_token', 'deletion_changed', 'blob', 'not secure erasure'):
            assert phrase in desc
        assert paths[path + '/deletion-impact']['get']['security']
    assert '/api/v1/submissions/{submission_id}' in paths
    assert '/api/v1/files/{file_id}' in paths


def test_assessment_plan_is_bound_to_actual_team_exercise_assessment_id(client):
    base, paths, (_, ex, _, _, _, _) = targets(client)
    sibling_team = create(client, base + '/teams', {'label': 'Second assessment owner'})
    sibling = base + '/teams/' + sibling_team['id'] + '/assessments/' + ex['id']
    assert client.put('/api/v1' + sibling, json={'revision': 0, 'rubric_revision': 1, 'notes': 'independent'}).status_code == 200
    target_preview = impact(client, paths['assessments'])
    sibling_preview = impact(client, sibling)
    assert target_preview['confirmation_token'] != sibling_preview['confirmation_token']
    before = snapshot(client)
    r = confirmed(client, sibling, target_preview)
    assert r.status_code == 409 and r.json()['code'] == 'deletion_changed'
    assert snapshot(client) == before
    assert confirmed(client, paths['assessments'], target_preview).status_code == 204
    assert client.get('/api/v1' + sibling).json()['id'] is not None
    assert client.get('/api/v1' + sibling + '/history').json()['total'] == 1


@pytest.mark.parametrize('reference', ['exercise', 'historical_submission'])
def test_foreign_current_and_historical_association_scope_is_rejected(client, reference):
    base, paths, (_, ex, team, _, _, sub) = targets(client)
    other, _, foreign_ex, foreign_team, _, _, foreign_sub = populated(client, 'Foreign owner')
    with client.app.state.catalog.db.connect(write=True) as db:
        if reference == 'exercise':
            db.execute("UPDATE assessments SET exercise_id=?,data=json_set(data,'$.exercise_id',?) WHERE team_id=?", (foreign_ex['id'], foreign_ex['id'], team['id']))
            target = paths['teams']
        else:
            row = db.execute('SELECT * FROM assessment_history WHERE assessment_id IN (SELECT id FROM assessments WHERE team_id=?) LIMIT 1', (foreign_team['id'],)).fetchone()
            data = json.loads(row['data'])
            data['submission_id'] = sub['id']
            db.execute('INSERT INTO assessment_history VALUES(?,?,?)', ('foreign-historic-link', row['assessment_id'], json.dumps(data)))
            target = paths['submissions']
    before = snapshot(client)
    assert client.get('/api/v1' + target + '/deletion-impact').status_code == 409
    assert client.delete('/api/v1' + target, params={'cascade': 'true', 'confirmation_token': '0' * 64}).status_code == 409
    assert snapshot(client) == before


def test_absent_assessment_delete_and_impact_are_not_found(client):
    base, _ = lab(client)
    ex = exercise(client, base)
    team = create(client, base + '/teams', {'label': 'Team'})
    path = base + '/teams/' + team['id'] + '/assessments/' + ex['id']
    assert client.get('/api/v1' + path).json()['revision'] == 0
    assert client.get('/api/v1' + path + '/history').json()['total'] == 0
    assert client.delete('/api/v1' + path).status_code == 404
    assert client.get('/api/v1' + path + '/deletion-impact').status_code == 404
