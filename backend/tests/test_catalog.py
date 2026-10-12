"""Synthetic API boundary tests; no legacy data, execution or providers."""
import io
import json
import os
import sqlite3
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def test_app_factory_exists():
    assert (Path(__file__).parents[1] / 'lab_catalog' / 'api.py').is_file(), 'new API factory is missing'
    from lab_catalog.api import create_app
    assert callable(create_app)


@pytest.fixture
def client(tmp_path):
    from lab_catalog.api import create_app
    app = create_app(tmp_path / 'state', allowed_hosts=['testserver'])
    with TestClient(app) as c:
        c.headers['Authorization'] = 'Bearer ' + (tmp_path / 'state' / 'operator-token').read_text().strip()
        yield c


def post(c, path, data):
    r = c.post('/api/v1' + path, json=data)
    assert r.status_code == 201, r.text
    return r.json()


def setup(c, criteria=False):
    lab = post(c, '/labs', {'title': 'Synthetic catalog', 'description': '<script>inert</script>'})
    base = '/labs/' + lab['id']
    ex = post(c, base + '/exercises', {'title': 'Exercise A', 'max_points': '10.25', 'grading_mode': 'criteria' if criteria else 'manual', 'criteria': [{'id': 'clarity', 'label': 'Clarity', 'max_points': '3.25'}, {'id': 'accuracy', 'label': 'Accuracy', 'max_points': '7'}] if criteria else []})
    team = post(c, base + '/teams', {'label': 'Synthetic team', 'members': [{'student_id': '00017', 'name': 'Example Person'}], 'membership_complete': True})
    return lab, ex, team, base


def gradepath(base, team, ex):
    return '/api/v1' + base + '/teams/' + team['id'] + '/assessments/' + ex['id']


def zipbytes(entries, compression=zipfile.ZIP_STORED):
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w', compression=compression) as z:
        for name, data in entries:
            z.writestr(name, data)
    return b.getvalue()


def upload(c, base, filename='notes.txt', data=b'synthetic', team=None):
    return c.post('/api/v1' + base + '/files', files={'file': (filename, data)}, data={'team_id': team} if team else {})


def test_lab_crud_revision_pagination_and_delete(client):
    a = post(client, '/labs', {'title': 'Alpha'})
    b = post(client, '/labs', {'title': 'Beta'})
    r = client.get('/api/v1/labs?limit=1&offset=1').json()
    assert r['total'] == 2 and r['limit'] == 1 and r['offset'] == 1 and r['items'][0]['id'] == b['id']
    p = '/api/v1/labs/' + a['id']
    assert client.patch(p, json={'revision': 0, 'title': 'bad'}).status_code == 409
    r = client.patch(p, json={'revision': a['revision'], 'archived': True})
    assert r.status_code == 200 and r.json()['revision'] == 2
    assert client.get(p).json()['archived'] is True
    assert client.delete(p).status_code == 204
    assert client.get(p).status_code == 404


@pytest.mark.parametrize('payload', [{'title': 'A', 'unknown': 1}, {'title': ''}, {'title': 12}])
def test_unknown_and_invalid_fields(client, payload):
    assert client.post('/api/v1/labs', json=payload).status_code == 422


@pytest.mark.parametrize('points', ['NaN', 'Infinity', '-1', '1000000001', '0.0000001', 1.1])
def test_decimal_is_finite_bounded_string(client, points):
    lab = post(client, '/labs', {'title': 'Synthetic'})
    assert client.post('/api/v1/labs/' + lab['id'] + '/exercises', json={'title': 'A', 'max_points': points}).status_code == 422


def test_criteria_sum_and_stable_ids_rubric_revision(client):
    lab, ex, team, base = setup(client, True)
    p = '/api/v1' + base + '/exercises/' + ex['id']
    r = client.patch(p, json={'revision': 1, 'title': 'Renamed', 'description': 'display'})
    assert r.status_code == 200 and r.json()['rubric_revision'] == 1
    r = client.patch(p, json={'revision': 2, 'grading_instructions': 'new instructions'})
    assert r.json()['rubric_revision'] == 2
    assert [x['id'] for x in r.json()['criteria']] == ['clarity', 'accuracy']
    for body in [{'grading_mode': 'manual', 'criteria': ex['criteria']}, {'grading_mode': 'criteria', 'criteria': []}, {'criteria': [{'id': 'x', 'label': 'X', 'max_points': '1'}]}]:
        assert client.patch(p, json={'revision': 3, **body}).status_code == 422


def test_partial_members_preserve_literal_identity(client):
    lab = post(client, '/labs', {'title': 'Synthetic'})
    base = '/labs/' + lab['id']
    t = post(client, base + '/teams', {'label': 'Empty', 'members': [], 'membership_complete': False})
    r = client.patch('/api/v1' + base + '/teams/' + t['id'], json={'revision': 1, 'members': [{'student_id': '00-X', 'name': 'Synthetic'}]})
    assert r.json()['members'][0]['student_id'] == '00-X' and r.json()['id'] == t['id']
    for members in [[], [{'student_id': '001', 'name': 'A'}, {'student_id': '001', 'name': 'B'}]]:
        assert client.post('/api/v1' + base + '/teams', json={'label': 'Invalid', 'membership_complete': True, 'members': members}).status_code == 422


def test_absent_assessment_is_unknown_not_zero(client):
    _, ex, team, base = setup(client)
    r = client.get(gradepath(base, team, ex)).json()
    assert r['id'] is None and r['status'] == 'ungraded' and r['score'] is None and r['revision'] == 0
    row = client.get('/api/v1' + base + '/overview').json()['rows'][0]
    assert row['grade_complete'] is False and row['awarded_points'] == '0'


def test_assessment_history_conflicts_notes_final_and_stale(client):
    _, ex, team, base = setup(client)
    p = gradepath(base, team, ex)
    r = client.put(p, json={'rubric_revision': 1, 'revision': 0, 'notes': 'Pending review'}); assert r.status_code == 200
    assert r.json()['score'] is None and r.json()['status'] == 'ungraded'
    assert client.put(p, json={'rubric_revision': 1, 'revision': 0, 'score': '5', 'status': 'final'}).status_code == 409
    assert client.put(p, json={'rubric_revision': 1, 'revision': 1, 'status': 'final'}).status_code == 422
    r = client.put(p, json={'rubric_revision': 1, 'revision': 1, 'score': '5.25', 'status': 'final', 'source': 'agent'})
    assert r.json()['score'] == '5.25' and r.json()['rubric_stale'] is False
    overview = client.get('/api/v1' + base + '/overview').json()
    assert overview['rows'][0]['grade_complete'] and overview['rows'][0]['awarded_points'] == '5.25'
    assert client.patch('/api/v1' + base + '/exercises/' + ex['id'], json={'revision': 1, 'max_points': '11'}).status_code == 200
    old = client.get(p).json()
    assert old['rubric_stale'] is True and old['score'] == '5.25' and old['rubric_snapshot']['max_points'] == '10.25'
    history = client.get(p + '/history?limit=1').json()
    assert history['total'] == 2 and history['items'][0]['notes'] == 'Pending review'
    row = client.get('/api/v1' + base + '/overview').json()['rows'][0]
    assert not row['grade_complete'] and row['awarded_points'] == '0'


def test_criterion_scores_compute_exact_sum(client):
    _, ex, team, base = setup(client, True)
    p = gradepath(base, team, ex)
    for data in [{'criterion_scores': {'clarity': '3.25'}}, {'criterion_scores': {'clarity': '4', 'accuracy': '2'}}, {'criterion_scores': {'clarity': '3.25', 'accuracy': '2'}, 'score': '9'}]:
        assert client.put(p, json={'rubric_revision': 1, 'revision': 0, 'status': 'final', **data}).status_code == 422
    r = client.put(p, json={'rubric_revision': 1, 'revision': 0, 'status': 'final', 'criterion_scores': {'clarity': '3.25', 'accuracy': '2'}})
    assert r.status_code == 200 and r.json()['score'] == '5.25'


def test_material_private_download_and_bounded_text(client):
    _, ex, team, base = setup(client)
    r = upload(client, base, 'unsafe.html', b'<script>alert(1)</script>'); assert r.status_code == 201
    f = r.json()
    m = post(client, base + '/materials', {'file_id': f['id'], 'exercise_id': ex['id'], 'role': 'grader', 'title': 'Inert source'})
    assert client.get('/api/v1' + base + '/materials').json()['items'][0]['id'] == m['id']
    assert client.get('/api/v1' + base + '/files').json()['total'] == 1
    for method in [client.get, client.head]:
        r = method('/api/v1/files/' + f['id'] + '/download')
        assert r.status_code == 200
        assert r.headers['content-type'] == 'application/octet-stream'
        assert 'attachment' in r.headers['content-disposition'] and r.headers['x-content-type-options'] == 'nosniff'
        assert 'sandbox' in r.headers['content-security-policy']
    assert client.get('/api/v1/files/' + f['id'] + '/text').json()['text'] == '<script>alert(1)</script>'
    assert client.delete('/api/v1' + base + '/materials/' + m['id']).status_code == 204


def test_submission_versions_inventory_literal_access(client):
    _, ex, team, base = setup(client)
    data = zipbytes([('nested/example.txt', b'hello'), ('empty/', b'')])
    p = '/api/v1' + base + '/teams/' + team['id'] + '/submissions'
    records = [client.post(p, files={'file': ('sample.zip', data)}).json() for _ in range(2)]
    assert records[0]['id'] != records[1]['id'] and records[0]['sha256'] == records[1]['sha256']
    assert client.get(p).json()['total'] == 2
    sid = records[0]['id']; path = '/api/v1/submissions/' + sid
    assert client.get(path).json()['archive_status'] == 'valid'
    assert client.get(path + '/members').json()['total'] == 2
    r = client.get(path + '/members/content', params={'path': 'nested/example.txt'})
    assert r.status_code == 200 and r.content == b'hello'
    assert client.get(path + '/members/content', params={'path': '../example.txt'}).status_code == 422
    r = client.put(gradepath(base, team, ex), json={'rubric_revision': 1, 'revision': 0, 'submission_id': sid, 'status': 'final', 'score': '1'})
    assert r.json()['submission_id'] == sid


@pytest.mark.parametrize('kind', ['notzip', 'traversal', 'duplicate', 'symlink', 'ratio', 'crc', 'codec', 'oversize', 'count'])
def test_unsafe_archives_preserved_blocked(client, kind):
    _, ex, team, base = setup(client)
    if kind == 'notzip': data = b'not a zip'
    elif kind == 'traversal': data = zipbytes([('../bad.txt', b'x')])
    elif kind == 'duplicate':
        with pytest.warns(UserWarning): data = zipbytes([('a', b'x'), ('a', b'y')])
    elif kind == 'symlink':
        b = io.BytesIO()
        with zipfile.ZipFile(b, 'w') as z:
            info = zipfile.ZipInfo('link'); info.create_system = 3; info.external_attr = 0o120777 << 16; z.writestr(info, 'target')
        data = b.getvalue()
    elif kind == 'ratio': data = zipbytes([('bomb', b'x' * 100000)], zipfile.ZIP_DEFLATED)
    elif kind == 'oversize': data = zipbytes([('large', b'x' * (8 * 1024 * 1024 + 1))])
    elif kind == 'count': data = zipbytes([(f'm{i}', b'') for i in range(1001)])
    else:
        data = bytearray(zipbytes([('member', b'hello')]))
        if kind == 'crc': data[36] ^= 1
        else:
            data[8:10] = (99).to_bytes(2, 'little'); i = data.index(b'PK\x01\x02'); data[i+10:i+12] = (99).to_bytes(2, 'little')
        data = bytes(data)
    r = client.post('/api/v1' + base + '/teams/' + team['id'] + '/submissions', files={'file': ('sample.zip', data)})
    assert r.status_code == 201, r.text
    sub = r.json(); assert sub['archive_status'] == 'blocked' and sub['archive_errors']
    assert client.get('/api/v1/files/' + sub['file_id'] + '/download').content == data
    assert client.get('/api/v1/submissions/' + sub['id'] + '/members/content', params={'path': 'member'}).status_code == 422


@pytest.mark.parametrize('kind', ['text', 'link', 'file', 'result'])
def test_evidence_all_kinds_never_auto_scores(client, kind):
    _, ex, team, base = setup(client)
    f = upload(client, base).json()
    p = base + '/teams/' + team['id'] + '/evidence'
    data = {'exercise_id': ex['id'], 'kind': kind, 'title': 'Synthetic evidence', 'source': 'agent'}
    data.update({'text': 'observed'} if kind == 'text' else {'url': 'https://example.invalid/evidence'} if kind == 'link' else {'file_id': f['id']} if kind == 'file' else {'data': {'checks': ['synthetic'], 'score': 999}})
    e = post(client, p, data)
    assert client.get('/api/v1' + p, params={'exercise_id': ex['id']}).json()['items'][0]['id'] == e['id']
    assert client.get(gradepath(base, team, ex)).json()['score'] is None
    assert client.delete('/api/v1' + p + '/' + e['id']).status_code == 204


def test_cross_lab_and_team_references_and_url_schemes(client):
    lab, ex, team, base = setup(client)
    lab2, ex2, team2, base2 = setup(client)
    f2 = upload(client, base2).json()
    other = post(client, base + '/teams', {'label': 'Other'})
    fother = upload(client, base, team=other['id']).json()
    assert client.post('/api/v1' + base + '/materials', json={'file_id': f2['id'], 'role': 'other', 'title': 'bad'}).status_code == 422
    assert client.get('/api/v1' + base + '/teams/' + team2['id'] + '/submissions').status_code == 404
    p = '/api/v1' + base + '/teams/' + team['id'] + '/evidence'
    for fields in [{'exercise_id': ex2['id'], 'kind': 'text', 'text': 'bad'}, {'exercise_id': ex['id'], 'kind': 'file', 'file_id': fother['id']}, {'exercise_id': ex['id'], 'kind': 'link', 'url': 'file:///etc/passwd'}, {'exercise_id': ex['id'], 'kind': 'link', 'url': 'javascript:alert(1)'}]:
        assert client.post(p, json={'title': 'Bad', **fields}).status_code == 422


def test_safe_delete_refuses_dependencies(client):
    _, ex, team, base = setup(client)
    assert client.delete('/api/v1' + base).status_code == 409
    upload(client, base, team=team['id'])
    assert client.delete('/api/v1' + base + '/teams/' + team['id']).status_code == 409
    client.put(gradepath(base, team, ex), json={'rubric_revision': 1, 'revision': 0, 'notes': 'kept'})
    assert client.delete('/api/v1' + base + '/exercises/' + ex['id']).status_code == 409


def test_export_history_and_restart_persistence(client, tmp_path):
    from lab_catalog.api import create_app
    lab, ex, team, base = setup(client)
    client.put(gradepath(base, team, ex), json={'rubric_revision': 1, 'revision': 0, 'status': 'final', 'score': '2'})
    export = client.get('/api/v1' + base + '/export').json()
    assert export['lab']['id'] == lab['id'] and len(export['assessment_history']) == 1
    assert str(tmp_path) not in json.dumps(export)
    with TestClient(create_app(tmp_path / 'state', ['testserver'])) as again:
        again.headers.update(client.headers)
        assert again.get(gradepath(base, team, ex)).json()['score'] == '2'
    db = sqlite3.connect(tmp_path / 'state' / 'catalog.sqlite3')
    assert db.execute('pragma user_version').fetchone()[0] == 2
    assert db.execute('pragma journal_mode').fetchone()[0] == 'wal'


def test_auth_host_origin_cookie_and_token_permissions(client, tmp_path):
    assert os.stat(tmp_path / 'state' / 'operator-token').st_mode & 0o777 == 0o600
    token = client.headers.pop('Authorization').removeprefix('Bearer ')
    assert client.get('/health').status_code == 200
    assert client.get('/api/v1/session').json() == {'authenticated': False}
    assert client.get('/api/v1/labs').status_code == 401
    assert client.get('/api/v1/labs', headers={'Authorization': 'Bearer invalid'}).status_code == 401
    for host in ['evil.invalid', 'testserver:9999', 'testserver.evil.invalid']:
        assert client.get('/health', headers={'Host': host}).status_code == 400
    assert client.get('/health', headers=[('Host', 'testserver'), ('Host', 'testserver')]).status_code == 400
    r = client.post('/api/v1/session', json={'token': token}, headers={'Origin': 'http://testserver'})
    assert r.status_code == 200 and 'HttpOnly' in r.headers['set-cookie'] and 'SameSite=strict' in r.headers['set-cookie']
    assert client.get('/api/v1/labs').status_code == 200
    assert client.post('/api/v1/labs', json={'title': 'Bad'}).status_code == 403
    assert client.post('/api/v1/labs', json={'title': 'Bad'}, headers={'Origin': 'http://evil.invalid'}).status_code == 403
    assert client.post('/api/v1/labs', json={'title': 'Good'}, headers={'Origin': 'http://testserver'}).status_code == 201
    assert client.delete('/api/v1/session', headers={'Origin': 'http://testserver'}).status_code == 204
    assert client.get('/api/v1/session').json() == {'authenticated': False}


def test_openapi_typed_auth_errors_and_limits(client):
    s = client.get('/openapi.json').json()
    assert all(token in s['info']['description'] for token in ('64 MiB', '8 MiB', '1000', '200', 'stored', 'deflate', 'ZIP64', '1 MiB', '65 MiB'))
    assert 'BearerAuth' in s['components']['securitySchemes'] and 'CookieAuth' in s['components']['securitySchemes']
    assert s['paths']['/api/v1/labs']['post']['requestBody']['content']['application/json']['schema']['$ref']
    assert s['paths']['/api/v1/labs']['get']['responses']['200']['content']['application/json']['schema']['$ref']
    for p in ['/api/v1/labs?limit=0', '/api/v1/labs?limit=201', '/api/v1/labs?offset=-1']:
        r = client.get(p); assert r.status_code == 422 and set(r.json()) == {'code', 'message', 'details'}
    r = client.get('/api/v1/labs/missing'); assert r.status_code == 404 and r.json()['code'] == 'not_found'
    assert client.post('/api/v1/labs', json={'title': 'A'}, headers={'Idempotency-Key': 'synthetic'}).status_code == 422


def test_symlink_private_roots_and_filename_traversal(client, tmp_path):
    from lab_catalog.api import create_app
    target = tmp_path / 'target'; target.mkdir()
    link = tmp_path / 'linked'; link.symlink_to(target, target_is_directory=True)
    with pytest.raises(ValueError): create_app(link, ['testserver'])
    lab = post(client, '/labs', {'title': 'Synthetic'})
    assert upload(client, '/labs/' + lab['id'], '../bad.txt').status_code == 422


def test_cli_help():
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).parents[1]))
    r = subprocess.run([sys.executable, '-m', 'lab_catalog', 'serve', '--help'], env=env, capture_output=True, text=True)
    assert r.returncode == 0 and '--data-dir' in r.stdout and '--allowed-host' in r.stdout and '--frontend-dir' in r.stdout


def test_frontend_whitelist_spa_not_api_and_trusted_assets(tmp_path):
    from lab_catalog.api import create_app
    frontend = tmp_path / 'public'; frontend.mkdir(); (frontend / 'assets').mkdir()
    (frontend / 'index.html').write_text('<html>synthetic app</html>')
    (frontend / 'assets' / 'app.js').write_text('console.log("synthetic")')
    outside = tmp_path / 'secret'; outside.write_text('secret')
    (frontend / 'leak.txt').symlink_to(outside)
    with TestClient(create_app(tmp_path / 'state', ['testserver'], frontend)) as c:
        assert c.get('/').status_code == 200
        assert c.get('/labs/example').status_code == 200
        assert c.get('/api/v1/typo', headers={'Authorization': 'Bearer ' + (tmp_path / 'state' / 'operator-token').read_text().strip()}).status_code == 404
        js = c.get('/assets/app.js'); assert js.status_code == 200 and 'javascript' in js.headers['content-type']
        assert 'sandbox' not in js.headers.get('content-security-policy', '')
        assert c.get('/leak.txt').status_code == 404
        assert c.get('/operator-token').status_code == 404
        assert c.get('/assets/../operator-token').status_code == 404
