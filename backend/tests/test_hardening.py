"""Synthetic boundary, race, failure and real-socket acceptance coverage."""
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import zipfile

import httpx
import pytest
from fastapi.testclient import TestClient

from test_catalog import client, setup, post, gradepath, upload, zipbytes


def test_criterion_order_is_display_only(client):
    _, ex, team, base = setup(client, True)
    p = gradepath(base, team, ex)
    assert client.put(p, json={'rubric_revision': 1, 'revision': 0, 'status': 'final', 'criterion_scores': {'clarity': '1', 'accuracy': '2'}}).status_code == 200
    criteria = list(reversed(ex['criteria']))

    r = client.patch('/api/v1' + base + '/exercises/' + ex['id'], json={'revision': 1, 'criteria': criteria})
    assert r.status_code == 200 and r.json()['rubric_revision'] == 1
    assert not client.get(p).json()['rubric_stale']


def test_aggregate_points_can_exceed_individual_bounds(client):
    lab = post(client, '/labs', {'title': 'Large synthetic totals'})
    base = '/labs/' + lab['id']
    team = post(client, base + '/teams', {'label': 'Synthetic'})
    for title in ['A', 'B']:
        ex = post(client, base + '/exercises', {'title': title, 'max_points': '1000000000'})
        assert client.put(gradepath(base, team, ex), json={'rubric_revision': 1, 'revision': 0, 'status': 'final', 'score': '1000000000'}).status_code == 200
    r = client.get('/api/v1' + base + '/overview')
    assert r.status_code == 200 and r.json()['rows'][0]['awarded_points'] == '2000000000'


def test_invalid_unicode_auth_is_401_not_server_error(client):
    assert client.post('/api/v1/session', json={'token': '☃'}).status_code == 401
    assert client.get('/api/v1/labs', headers={'Authorization': b'Bearer \xe9'}).status_code == 401


    r = client.post('/api/v1/labs', content=b'{"title":"\\ud800"}', headers={'Content-Type': 'application/json'})
    assert r.status_code == 422


def test_nonascii_cookie_signature_is_unauthenticated(client):
    client.headers.pop('Authorization')
    expiry = str(int(time.time()) + 300)
    assert client.get('/api/v1/labs', headers={'Cookie': f'lab_catalog_session={expiry}.nonce.'.encode() + b'\xe9'}).status_code == 401


def test_raw_json_structure_is_bounded_and_duplicates_rejected(client):
    for raw in [b'{"title":"A","title":"B"}', b'{"title":"A","description":' + b'[' * 1000 + b'0' + b']' * 1000 + b'}']:
        assert client.post('/api/v1/labs', content=raw, headers={'Content-Type': 'application/json'}).status_code == 422


def test_upload_http_storage_failure_is_sanitized_and_atomic(client, tmp_path):
    _, ex, team, base = setup(client)
    with client.app.state.catalog.db.connect(write=True) as db:
        db.execute("CREATE TRIGGER synthetic_reject BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    r = upload(client, base)
    assert r.status_code == 500 and r.json()['code'] == 'storage_error'
    assert 'synthetic failure' not in r.text and str(tmp_path) not in r.text
    assert client.get('/api/v1' + base + '/files').json()['total'] == 0
    assert not list((tmp_path / 'state' / 'blobs').iterdir())


def test_zip_central_inventory_bounded_before_zipfile_parser():
    from lab_catalog.files import preflight_zip
    # Member limits apply before zipfile builds its unbounded in-memory inventory.
    assert preflight_zip(zipbytes([(f'm{i}', b'') for i in range(1001)]))
    assert preflight_zip(zipbytes([('healthy', b'ok')])) is None


@pytest.mark.parametrize('content_type', [None, 'application/json', 'application/vnd.synthetic+json'])
def test_json_validation_applies_to_all_json_media_types(client, content_type):
    headers = {'Content-Type': content_type} if content_type else {}
    r = client.post('/api/v1/labs', content=b'{"title":"A","title":"B"}', headers=headers)
    assert r.status_code == 422


def test_expired_cookie_and_origin_exact_port_scheme(client):
    from lab_catalog.api import COOKIE
    token = client.headers.pop('Authorization').removeprefix('Bearer ')
    r = client.post('/api/v1/session', json={'token': token}, headers={'Origin': 'http://testserver'})
    assert r.status_code == 200
    for origin in ['https://testserver', 'http://testserver:80', 'null']:
        assert client.post('/api/v1/labs', json={'title': 'Bad'}, headers={'Origin': origin}).status_code == 403
    client.cookies.set(COOKIE, '1.nonce.signature', domain='testserver.local', path='/api/v1')
    assert client.get('/api/v1/session').json()['authenticated'] is False
    assert client.get('/api/v1/labs').status_code == 401


def test_live_upload_individual_cap_and_live_inert_download(live):
    c, root, port = live
    lab = post(c, '/labs', {'title': 'Live limits'})
    base = '/labs/' + lab['id']
    f = upload(c, base, 'inert.svg', b'<svg><script>alert(1)</script></svg>').json()
    r = c.get('/api/v1/files/' + f['id'] + '/download')
    assert r.status_code == 200 and r.headers['content-type'] == 'application/octet-stream' and 'sandbox' in r.headers['content-security-policy']
    def chunks():
        yield b'--synthetic\r\nContent-Disposition: form-data; name="file"; filename="large.txt"\r\n\r\n'
        for _ in range(64): yield b'x' * 1024 * 1024
        yield b'x\r\n--synthetic--\r\n'
    r = c.post('/api/v1' + base + '/files', content=chunks(), headers={'Content-Type': 'multipart/form-data; boundary=synthetic'})
    assert r.status_code == 413 and r.json()['code'] == 'limit'
    assert c.get('/api/v1' + base + '/files').json()['total'] == 1
    assert len(list((root / 'blobs').iterdir())) == 1


def test_zero_is_an_explicit_final_score_and_drafts_are_excluded(client):
    _, ex, team, base = setup(client)
    p = gradepath(base, team, ex)
    assert client.put(p, json={'rubric_revision': 1, 'revision': 0, 'status': 'draft', 'score': '3'}).status_code == 200
    row = client.get('/api/v1' + base + '/overview').json()['rows'][0]
    assert row['awarded_points'] == '0' and not row['grade_complete']
    assert client.put(p, json={'rubric_revision': 1, 'revision': 1, 'status': 'final', 'score': '0'}).status_code == 200
    row = client.get('/api/v1' + base + '/overview').json()['rows'][0]
    assert row['awarded_points'] == '0' and row['grade_complete']


def test_cross_team_submission_bindings_rejected(client):
    _, ex, team, base = setup(client)
    other = post(client, base + '/teams', {'label': 'Other synthetic'})
    p = '/api/v1' + base + '/teams/' + other['id'] + '/submissions'
    sub = client.post(p, files={'file': ('sample.zip', zipbytes([('a', b'a')]))}).json()
    assert client.put(gradepath(base, team, ex), json={'rubric_revision': 1, 'revision': 0, 'status': 'final', 'score': '1', 'submission_id': sub['id']}).status_code == 422
    p = '/api/v1' + base + '/teams/' + team['id'] + '/evidence'
    assert client.post(p, json={'exercise_id': ex['id'], 'kind': 'text', 'title': 'Synthetic', 'text': 'Synthetic', 'submission_id': sub['id']}).status_code == 422
    assert client.get(gradepath(base, team, ex) + '/history').json()['total'] == 0


def test_zip_total_declared_size_bound_and_windows_paths(client):
    _, ex, team, base = setup(client)
    data = bytearray(zipbytes([(f'm{i}', b'x') for i in range(9)]))
    pos = 0
    while True:
        pos = data.find(b'PK\x01\x02', pos)
        if pos < 0: break
        data[pos + 24:pos + 28] = (8 * 1024 * 1024).to_bytes(4, 'little')
        pos += 4
    p = '/api/v1' + base + '/teams/' + team['id'] + '/submissions'
    r = client.post(p, files={'file': ('declared.zip', bytes(data))})
    assert r.status_code == 201 and any('total uncompressed size' in x for x in r.json()['archive_errors'])
    for name in ['C:/absolute.txt', r'folder\bad.txt', '/absolute.txt', 'a/./b']:
        r = client.post(p, files={'file': ('unsafe.zip', zipbytes([(name, b'x')]))})
        assert r.status_code == 201 and r.json()['archive_status'] == 'blocked'
        assert r.json()['members'][0]['errors'] == ['unsafe member path']


def test_result_evidence_requires_finite_json(client):
    _, ex, team, base = setup(client)
    data = {'exercise_id': ex['id'], 'kind': 'result', 'title': 'Invalid synthetic', 'data': {'nested': [float('nan')]}}
    r = client.post('/api/v1' + base + '/teams/' + team['id'] + '/evidence', content=json.dumps(data), headers={'Content-Type': 'application/json'})
    assert r.status_code == 422
    assert client.get('/api/v1' + base + '/teams/' + team['id'] + '/evidence').json()['total'] == 0


def test_upload_rollback_does_not_remove_committed_shared_blob(client, tmp_path):
    _, ex, team, base = setup(client)
    cat = client.app.state.catalog
    # Real SQLite failure using a database trigger; no mocked persistence.
    with cat.db.connect(write=True) as db:
        db.execute("CREATE TRIGGER synthetic_reject BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    with pytest.raises(sqlite3.IntegrityError):
        cat.upload(base.split('/')[-1], None, 'synthetic.txt', io.BytesIO(b'unique'), 'text/plain')
    assert list((tmp_path / 'state' / 'blobs').iterdir()) == []
    with cat.db.connect(write=True) as db:
        db.execute('DROP TRIGGER synthetic_reject')
    f = upload(client, base, data=b'shared').json()
    with cat.db.connect(write=True) as db:
        db.execute("CREATE TRIGGER synthetic_reject BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    with pytest.raises(sqlite3.IntegrityError):
        cat.upload(base.split('/')[-1], None, 'synthetic.txt', io.BytesIO(b'shared'), 'text/plain')
    assert client.get('/api/v1/files/' + f['id'] + '/download').content == b'shared'
    assert client.get('/api/v1' + base + '/files').json()['total'] == 1


def test_blob_publish_failure_leaves_no_metadata_or_orphan(client, tmp_path, monkeypatch):
    _, ex, team, base = setup(client)
    original = os.chmod
    def fail_publish(path, mode):
        if Path(path).parent.name == 'blobs': raise OSError('synthetic publish failure')
        return original(path, mode)
    monkeypatch.setattr(os, 'chmod', fail_publish)
    r = upload(client, base, data=b'publish failure')
    assert r.status_code == 500 and r.json()['code'] == 'storage_error'
    assert client.get('/api/v1' + base + '/files').json()['total'] == 0
    assert list((tmp_path / 'state' / 'blobs').iterdir()) == []
    monkeypatch.setattr(os, 'chmod', original)
    assert upload(client, base, data=b'publish failure').status_code == 201


def test_failed_upload_cleanup_keeps_interleaved_committed_reference(client, monkeypatch):
    from contextlib import contextmanager
    _, ex, team, base = setup(client)
    cat = client.app.state.catalog
    lab_id = base.split('/')[-1]
    with cat.db.connect(write=True) as db:
        db.execute("CREATE TRIGGER synthetic_reject BEFORE INSERT ON files WHEN json_extract(NEW.data,'$.filename')='rejected.txt' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    original_connect = cat.db.connect
    recovered = []
    @contextmanager
    def interleaved(write=False):
        try:
            with original_connect(write) as db: yield db
        except sqlite3.IntegrityError:
            monkeypatch.setattr(cat.db, 'connect', original_connect)
            recovered.append(cat.upload(lab_id, None, 'recovered.txt', io.BytesIO(b'interleaved'), 'text/plain'))
            raise
    monkeypatch.setattr(cat.db, 'connect', interleaved)
    with pytest.raises(sqlite3.IntegrityError):
        cat.upload(lab_id, None, 'rejected.txt', io.BytesIO(b'interleaved'), 'text/plain')
    r = client.get('/api/v1/files/' + recovered[0]['id'] + '/download')
    assert r.status_code == 200 and r.content == b'interleaved'


def test_concurrent_revision_writes_only_one_wins(client):
    lab, ex, team, base = setup(client)
    barrier = threading.Barrier(2); results = []
    def update(title):
        barrier.wait()
        results.append(client.patch('/api/v1' + base, json={'revision': 1, 'title': title}).status_code)
    threads = [threading.Thread(target=update, args=(x,)) for x in ['A', 'B']]
    for t in threads: t.start()
    for t in threads: t.join(timeout=10)
    assert sorted(results) == [200, 409]
    assert client.get('/api/v1' + base).json()['revision'] == 2


def test_blob_hash_and_symlink_integrity(client, tmp_path):
    _, ex, team, base = setup(client)
    f = upload(client, base).json()
    p = tmp_path / 'state' / 'blobs' / f['sha256']
    p.chmod(0o600); p.write_bytes(b'corrupted')
    r = client.get('/api/v1/files/' + f['id'] + '/download')
    assert r.status_code == 409 and str(tmp_path) not in r.text
    p.unlink(); outside = tmp_path / 'private'; outside.write_text('secret'); p.symlink_to(outside)
    assert client.get('/api/v1/files/' + f['id'] + '/download').status_code == 409


def test_audit_records_immutable_at_database_boundary(client):
    _, ex, team, base = setup(client)
    p = gradepath(base, team, ex)
    assert client.put(p, json={'rubric_revision': 1, 'revision': 0, 'notes': 'original'}).status_code == 200
    for sql in ['UPDATE assessment_history SET data=\'{}\'', 'DELETE FROM assessment_history']:
        with pytest.raises(sqlite3.IntegrityError):
            with client.app.state.catalog.db.connect(write=True) as c: c.execute(sql)
    assert client.get(p + '/history').json()['items'][0]['notes'] == 'original'
    with client.app.state.catalog.db.connect(write=True) as db:
        assert db.execute('pragma foreign_keys').fetchone()[0] == 1
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO teams(id,lab_id,data) VALUES ('synthetic','missing','{}')")


def test_zip_decoder_failure_contained_and_next_upload_healthy(client):
    _, ex, team, base = setup(client)
    data = bytearray(zipbytes([('healthy', b'ok'), ('corrupt', b'synthetic bytes' * 10)], zipfile.ZIP_DEFLATED))
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        info = z.getinfo('corrupt'); start = info.header_offset + 30 + len(info.filename.encode()) + len(info.extra)
    # Reserved DEFLATE block type, while retaining real local/central inventory.
    data[start] = (data[start] & 0xf8) | 0x07
    p = '/api/v1' + base + '/teams/' + team['id'] + '/submissions'
    for _ in range(2):
        r = client.post(p, files={'file': ('synthetic.zip', bytes(data))})
        assert r.status_code == 201 and r.json()['archive_status'] == 'blocked'
        assert r.json()['members'][0]['status'] == 'valid'
        assert 'decoder or CRC' in r.json()['members'][1]['errors'][0]
    healthy = client.post(p, files={'file': ('synthetic.zip', zipbytes([('healthy', b'ok')], zipfile.ZIP_DEFLATED))})
    assert healthy.status_code == 201 and healthy.json()['archive_status'] == 'valid'
    assert client.get(p).json()['total'] == 3
    assert not list((client.app.state.catalog.db.root / 'blobs').glob('.pending-*'))


def test_multipart_unknown_duplicate_and_empty_team_rejected(client):
    _, _, _, base = setup(client)
    p = '/api/v1' + base + '/files'
    assert client.post(p, files={'file': ('a.txt', b'a')}, data={'unknown': 'x'}).status_code == 422
    assert client.post(p, files=[('file', ('a.txt', b'a')), ('file', ('b.txt', b'b'))]).status_code == 422
    assert client.post(p, files={'file': ('a.txt', b'a')}, data={'team_id': ''}).status_code == 422


def test_all_list_pagination_and_archiving_preserve_state(client):
    _, ex, team, base = setup(client)
    post(client, base + '/exercises', {'title': 'B', 'position': 3, 'max_points': '5'})
    post(client, base + '/teams', {'label': 'B'})
    for suffix in ['/exercises', '/teams']:
        p = '/api/v1' + base + suffix
        first = client.get(p + '?limit=1').json(); second = client.get(p + '?limit=1&offset=1').json()
        assert first['total'] == second['total'] == 2 and first['items'][0]['id'] != second['items'][0]['id']
    assert client.patch('/api/v1' + base + '/teams/' + team['id'], json={'revision': 0, 'archived': True}).status_code == 409
    assert client.patch('/api/v1' + base + '/teams/' + team['id'], json={'revision': 1, 'archived': True}).status_code == 200
    assert client.get('/api/v1' + base + '/overview').json()['total'] == 2
    assert client.patch('/api/v1' + base + '/exercises/' + ex['id'], json={'revision': 1, 'archived': True}).status_code == 200
    assert client.get('/api/v1' + base + '/overview').json()['rows'][0]['total_points'] == '5'


@pytest.fixture
def live(tmp_path):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    root = tmp_path / 'live'
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).parents[1]))
    process = subprocess.Popen([sys.executable, '-m', 'lab_catalog', 'serve', '--data-dir', str(root), '--host', '127.0.0.1', '--port', str(port), '--allowed-host', f'127.0.0.1:{port}'], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    url = f'http://127.0.0.1:{port}'
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError(process.communicate()[1].decode())
            try:
                if httpx.get(url + '/health').status_code == 200: break
            except httpx.ConnectError: pass
            time.sleep(0.025)
        else: raise AssertionError('live CLI did not become ready')
        with httpx.Client(base_url=url, headers={'Authorization': 'Bearer ' + (root / 'operator-token').read_text().strip()}, timeout=30) as c:
            yield c, root, port
    finally:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)


def raw_http(port, headers):
    with socket.create_connection(('127.0.0.1', port), timeout=5) as s:
        s.sendall(b'GET /health HTTP/1.1\r\n' + headers + b'Connection: close\r\n\r\n')
        result = b''
        while part := s.recv(65536): result += part
        return result


def test_live_cli_exact_host_and_missing_duplicate_rejected(live):
    c, root, port = live
    assert c.get('/health').status_code == 200
    assert c.get('/api/v1/labs', headers={'Host': f'127.0.0.1:{port + 1}'}).status_code == 400
    assert b'400' in raw_http(port, b'').split(b'\r\n', 1)[0]
    assert b'400' in raw_http(port, f'Host: 127.0.0.1:{port}\r\nHost: evil.invalid\r\n'.encode()).split(b'\r\n', 1)[0]
    lab = post(c, '/labs', {'title': 'Live synthetic'})
    assert c.get('/api/v1/labs/' + lab['id']).json()['title'] == 'Live synthetic'
    c.headers.pop('Authorization')
    assert c.get('/api/v1/labs').status_code == 401


def test_live_chunked_and_declared_body_limits_before_storage(live):
    c, root, port = live
    lab = post(c, '/labs', {'title': 'Live bounded'})
    p = '/api/v1/labs/' + lab['id'] + '/files'
    def chunks():
        yield b'--synthetic\r\nContent-Disposition: form-data; name="file"; filename="large.txt"\r\n\r\n'
        for _ in range(66): yield b'x' * 1024 * 1024
        yield b'\r\n--synthetic--\r\n'
    r = c.post(p, content=chunks(), headers={'Content-Type': 'multipart/form-data; boundary=synthetic'})
    assert r.status_code == 413 and r.json()['code'] == 'limit'
    assert c.get('/api/v1/labs/' + lab['id'] + '/files').json()['total'] == 0
    assert not list((root / 'blobs').iterdir())
    with socket.create_connection(('127.0.0.1', port), timeout=5) as s:
        auth = c.headers['Authorization']
        s.sendall(f'POST /api/v1/labs HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {auth}\r\nContent-Length: {70 * 1024 * 1024}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n'.encode())
        result = b''
        while part := s.recv(65536): result += part
        assert b'413' in result.split(b'\r\n', 1)[0]
