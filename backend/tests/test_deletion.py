"""Deletion contracts use isolated synthetic SQLite state only."""
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from lab_catalog.api import create_app

from lab_catalog.service import CatalogError


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path / 'deletion-state', ['testserver'])
    with TestClient(app) as c:
        c.headers['Authorization'] = 'Bearer ' + (tmp_path / 'deletion-state' / 'operator-token').read_text().strip()
        yield c


def create(c, path, body):
    r = c.post('/api/v1' + path, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def target(c, kind):
    lab = create(c, '/labs', {'title': 'Synthetic deletion'})
    base = '/labs/' + lab['id']
    if kind == 'lab':
        return base, lab
    ex = create(c, base + '/exercises', {'title': 'Synthetic exercise', 'max_points': '3'})
    return base + '/exercises/' + ex['id'], ex


@pytest.mark.parametrize('kind', ['lab', 'exercise'])
def test_guarded_delete_conflicts_then_accepts_current_revision(client, kind):
    path, obj = target(client, kind)
    p = '/api/v1' + path
    changed = client.patch(p, json={'revision': obj['revision'], 'title': 'New title'}).json()
    r = client.delete(p + '?revision=1')
    assert r.status_code == 409
    assert r.json()['details'] == {'current_revision': 2}
    assert client.get(p).json() == changed
    assert client.delete(p + '?revision=2').status_code == 204
    assert client.get(p).status_code == 404
    assert client.delete(p + '?revision=2').status_code == 404


@pytest.mark.parametrize('kind', ['lab', 'exercise'])
@pytest.mark.parametrize('revision', ['0', '-1', 'bad', '1.5', ''])
def test_delete_query_revision_is_validated_without_writing(client, kind, revision):
    path, obj = target(client, kind)
    p = '/api/v1' + path
    assert client.delete(p + '?revision=' + revision).status_code == 422
    assert client.get(p).json() == obj


@pytest.mark.parametrize('kind', ['lab', 'exercise'])
def test_legacy_unguarded_delete_and_missing_contract(client, kind):
    path, _ = target(client, kind)
    p = '/api/v1' + path
    assert client.delete(p).status_code == 204
    assert client.get(p).status_code == 404
    assert client.delete(p).status_code == 404


def test_exercise_delete_checks_lab_ownership_before_revision(client):
    path, ex = target(client, 'exercise')
    other = create(client, '/labs', {'title': 'Other synthetic owner'})
    wrong = '/api/v1/labs/' + other['id'] + '/exercises/' + ex['id']
    assert client.delete(wrong + '?revision=99').status_code == 404
    assert client.delete('/api/v1/labs/missing/exercises/' + ex['id']).status_code == 404
    assert client.get('/api/v1' + path).json() == ex


@pytest.mark.parametrize('dependency', ['exercise', 'team', 'file', 'material', 'evidence', 'assessment'])
def test_dependencies_reject_deletion_without_cascade_or_history_loss(client, dependency):
    path, ex = target(client, 'exercise')
    base = path.split('/exercises/')[0]
    lab_before = client.get('/api/v1' + base).json()
    team = None
    grade = None
    if dependency in ('team', 'evidence', 'assessment'):
        team = create(client, base + '/teams', {'label': 'Synthetic team'})
    if dependency in ('file', 'material'):
        r = client.post('/api/v1' + base + '/files', files={'file': ('synthetic.txt', b'inert bytes', 'text/plain')})
        assert r.status_code == 201
        f = r.json()
        if dependency == 'material':
            create(client, base + '/materials', {'title': 'Synthetic material', 'role': 'handout', 'file_id': f['id'], 'exercise_id': ex['id']})
    if dependency == 'evidence':
        create(client, base + '/teams/' + team['id'] + '/evidence', {'title': 'Synthetic evidence', 'kind': 'text', 'text': 'Inert note', 'exercise_id': ex['id']})
    if dependency == 'assessment':
        grade = '/api/v1' + base + '/teams/' + team['id'] + '/assessments/' + ex['id']
        for revision in (0, 1):
            r = client.put(grade, json={'revision': revision, 'rubric_revision': 1, 'score': '2', 'status': 'final', 'notes': str(revision)})
            assert r.status_code == 200, r.text
        history = client.get(grade + '/history').json()
        assessment = client.get(grade).json()
    # Every lab has the exercise dependency. Only the last three dependencies
    # reference this exercise; unrelated teams/files must not block its deletion.
    before = client.get('/api/v1' + base + '/export').json()
    r = client.delete('/api/v1' + base + '?revision=1')
    assert r.status_code == 409 and 'archive instead' in r.json()['message']
    assert client.get('/api/v1' + base).json() == lab_before
    if dependency in ('material', 'evidence', 'assessment'):
        r = client.delete('/api/v1' + path + '?revision=1')
        assert r.status_code == 409 and 'archive instead' in r.json()['message']
        assert client.get('/api/v1' + path).json() == ex
    assert client.get('/api/v1' + base + '/export').json() == before
    if grade:
        assert client.get(grade).json() == assessment
        assert client.get(grade + '/history').json() == history
    if dependency in ('file', 'material'):
        assert client.get('/api/v1/files/' + f['id'] + '/download').content == b'inert bytes'


@pytest.mark.parametrize('kind', ['lab', 'exercise'])
def test_guarded_delete_serializes_with_another_guarded_delete(client, kind):
    path, obj = target(client, kind)
    catalog = client.app.state.catalog
    table = 'labs' if kind == 'lab' else 'exercises'
    def remove():
        try:
            catalog.delete(table, obj['id'], obj.get('lab_id'), revision=1)
            return 204
        except CatalogError as exc:
            return exc.status
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: remove(), range(2))) == [204, 404]


@pytest.mark.parametrize('kind', ['lab', 'exercise'])
def test_revision_check_uses_committed_transaction_state(client, kind):
    path, obj = target(client, kind)
    catalog = client.app.state.catalog
    table = 'labs' if kind == 'lab' else 'exercises'
    # Hold a real SQLite write transaction while a guarded delete waits.
    with ThreadPoolExecutor(max_workers=1) as pool:
        with catalog.db.connect(write=True) as c:
            obj['revision'] = 2
            catalog.db.save(c, table, obj, ('lab_id',) if kind == 'exercise' else (), update=True)
            waiting = pool.submit(catalog.delete, table, obj['id'], obj.get('lab_id'), revision=1)
        with pytest.raises(CatalogError) as err:
            waiting.result(timeout=10)
    assert err.value.status == 409 and err.value.details == {'current_revision': 2}
    assert client.get('/api/v1' + path).json()['revision'] == 2


@pytest.mark.parametrize('kind', ['lab', 'exercise'])
def test_deletion_requires_authentication(client, kind):
    path, obj = target(client, kind)
    auth = client.headers.pop('Authorization')
    assert client.delete('/api/v1' + path + '?revision=1').status_code == 401
    client.headers['Authorization'] = auth
    assert client.get('/api/v1' + path).json() == obj


def test_team_delete_rejects_invalid_revision_and_retains_legacy_unguarded_contract(client):
    path, _ = target(client, 'lab')
    team = create(client, path + '/teams', {'label': 'Synthetic team'})
    team_path = '/api/v1' + path + '/teams/' + team['id']
    assert client.delete(team_path + '?revision=0').status_code == 422
    assert client.get(team_path).json() == team
    assert client.delete(team_path).status_code == 204


@pytest.mark.parametrize('dependency', ['team', 'file'])
def test_lab_real_dependencies_block_but_orphan_metadata_is_cleaned(client, dependency):
    path, lab = target(client, 'lab')
    if dependency == 'team':
        create(client, path + '/teams', {'label': 'Synthetic team dependency'})
    else:
        r = client.post('/api/v1' + path + '/files', files={'file': ('synthetic.txt', b'inert bytes', 'text/plain')})
        assert r.status_code == 201
        f = r.json()
    before = client.get('/api/v1' + path + '/export').json()
    r = client.delete('/api/v1' + path + '?revision=1')
    if dependency == 'team':
        assert r.status_code == 409 and 'archive instead' in r.json()['message']
        assert client.get('/api/v1' + path).json() == lab
        assert client.get('/api/v1' + path + '/export').json() == before
    else:
        assert r.status_code == 204
        assert client.get('/api/v1' + path).status_code == 404
        assert client.get('/api/v1/files/' + f['id']).status_code == 404
        assert client.app.state.catalog.blobs.read(f['sha256'], f['size']) == b'inert bytes'


def test_revision_conflict_takes_precedence_over_dependencies(client):
    path, _ = target(client, 'lab')
    create(client, path + '/teams', {'label': 'Synthetic dependency'})
    assert client.patch('/api/v1' + path, json={'revision': 1, 'title': 'Revision 2'}).status_code == 200
    conflict = client.delete('/api/v1' + path + '?revision=1')
    assert conflict.status_code == 409
    assert conflict.json()['details'] == {'current_revision': 2}
    dependent = client.delete('/api/v1' + path + '?revision=2')
    assert dependent.status_code == 409 and 'archive instead' in dependent.json()['message']
