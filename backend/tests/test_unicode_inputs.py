"""Unicode scalar containment using synthetic ASGI and real CLI/SQLite state."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from lab_catalog import schemas as s
from test_catalog import client, setup, post, gradepath


BAD_DATA = [
    pytest.param('\ud800', id='high-scalar'),
    pytest.param('\udfff', id='low-scalar'),
    pytest.param({'nested': '\ud800'}, id='object-value'),
    pytest.param({'\ud800': 'value'}, id='object-key'),
    pytest.param([{'deep': [False, {'value': 'private-body-marker\udfff'}]}], id='deep-value'),
    pytest.param({'deep': [{'inner': {'private-body-marker\udfff': 'value'}}]}, id='deep-key'),
    pytest.param({'nested': '\ud800x\udfff'}, id='unpaired-mixed'),
    pytest.param({'nested': '\udfff\ud800'}, id='reversed-pair'),
]
MEDIA_TYPES = [None, 'application/json; charset=utf-8', 'application/vnd.synthetic+json']
VALID_DATA = {'😀': ['Ελληνικά', 'e\u0301', '', {'counter': 9007199254740993, 'huge': 10**100, 'negative': -(10**100), 'fraction': 1.25, 'flag': False, 'null': None}]}


def raw_request(c, method, path, body, content_type='application/json'):
    # Escapes make malformed scalars valid wire JSON, not a client encoder error.
    headers = {'Content-Type': content_type} if content_type else {}
    return c.request(method, path, content=json.dumps(body, ensure_ascii=True).encode('ascii'), headers=headers)


def assert_validation(response):
    assert response.status_code == 422, (response.status_code, response.text)
    assert response.headers['content-type'].startswith('application/json')
    assert set(response.json()) == {'code', 'message', 'details'}
    assert response.json()['code'] == 'validation'
    assert 'private-body-marker' not in response.text
    assert '\\ud800' not in response.text and '\\udfff' not in response.text
    assert 'UnicodeEncodeError' not in response.text and 'Traceback' not in response.text


def evidence_records(c):
    _, ex, team, base = setup(c)
    collection = '/api/v1' + base + '/teams/' + team['id'] + '/evidence'
    payload = {'exercise_id': ex['id'], 'kind': 'result', 'title': 'Healthy 😀', 'data': VALID_DATA}
    existing = raw_request(c, 'POST', collection, payload)
    assert existing.status_code == 201, existing.text
    item = collection + '/' + existing.json()['id']
    return collection, payload, item, existing.json(), ex, team, base


@pytest.mark.parametrize('data', BAD_DATA)
@pytest.mark.parametrize('method', ['POST', 'PATCH'])
@pytest.mark.parametrize('content_type', MEDIA_TYPES)
def test_asgi_evidence_rejects_surrogate_keys_and_values(client, data, method, content_type):
    with TestClient(client.app, raise_server_exceptions=False) as c:
        c.headers.update(client.headers)
        collection, payload, item, before, *_ = evidence_records(c)
        body = {**payload, 'data': data} if method == 'POST' else {'revision': 1, 'data': data}
        response = raw_request(c, method, collection if method == 'POST' else item, body, content_type)
        assert_validation(response)
        assert c.get(item).json() == before
        assert c.get(collection).json()['total'] == 1
        healthy = raw_request(c, 'POST', collection, payload)
        assert healthy.status_code == 201 and healthy.json()['data'] == VALID_DATA


@pytest.mark.parametrize('model', [s.EvidenceCreate, s.EvidencePatch])
@pytest.mark.parametrize('data', BAD_DATA)
def test_direct_evidence_models_reject_surrogates(model, data):
    body = {'exercise_id': 'synthetic', 'kind': 'result', 'title': 'Healthy', 'data': data} if model is s.EvidenceCreate else {'revision': 1, 'data': data}
    with pytest.raises(ValidationError):
        model.model_validate(body)


@pytest.mark.parametrize('model,body', [
    (s.LabCreate, {'title': '\ud800'}),
    (s.TeamCreate, {'label': 'Healthy', 'notes': 'private-body-marker\udfff'}),
    (s.TeamCreate, {'label': 'Healthy', 'members': [{'student_id': '00-Ε', 'name': '\ud800'}]}),
    (s.ExerciseCreate, {'title': 'Healthy', 'max_points': '1', 'grading_mode': 'criteria', 'criteria': [{'id': '\ud800', 'label': 'Healthy', 'max_points': '1'}]}),
    (s.AssessmentPut, {'revision': 0, 'rubric_revision': 1, 'notes': '\ud800'}),
    (s.AssessmentPut, {'revision': 0, 'rubric_revision': 1, 'criterion_scores': {'\ud800': '1'}}),
    (s.SessionInput, {'token': 'private-body-marker\ud800'}),
])
def test_direct_metadata_models_reject_surrogates(model, body):
    with pytest.raises(ValidationError):
        model.model_validate(body)


def test_asgi_unicode_rejected_before_endpoint_and_safe_error_details(client):
    entered = []

    @client.app.post('/api/v1/synthetic-unicode-boundary')
    def sentinel():
        entered.append(True)
        return {'accepted': True}

    for content_type in MEDIA_TYPES:
        response = raw_request(client, 'POST', '/api/v1/synthetic-unicode-boundary', {'private-body-marker\ud800': ['ok']}, content_type)
        assert_validation(response)
    assert entered == []
    assert raw_request(client, 'POST', '/api/v1/synthetic-unicode-boundary', {'😀': 'Ε'}).status_code == 200
    assert entered == [True]


@pytest.mark.parametrize('content_type', MEDIA_TYPES[1:])
def test_valid_unicode_pairs_names_and_large_integers_round_trip(client, content_type):
    collection, payload, item, before, ex, team, base = evidence_records(client)
    for ensure_ascii in [True, False]:
        response = client.post(collection, content=json.dumps(payload, ensure_ascii=ensure_ascii).encode('utf-8'), headers={'Content-Type': content_type} if content_type else {})
        assert response.status_code == 201, response.text
        saved = response.json()
        assert saved['data'] == VALID_DATA and saved['title'] == payload['title']
        assert client.get(collection + '/' + saved['id']).json() == saved
    changed = raw_request(client, 'PATCH', item, {'revision': 1, 'title': 'Διόρθωση 😀'}, content_type)
    assert changed.status_code == 200 and changed.json()['data'] == VALID_DATA
    assert client.get(item).json() == changed.json()
    path = '/api/v1' + base + '/teams/' + team['id']
    response = raw_request(client, 'PATCH', path, {'revision': 1, 'members': [{'student_id': '00-Ε😀', 'name': 'Ονομα e\u0301 😀'}], 'notes': ''}, content_type)
    assert response.status_code == 200
    assert client.get(path).json()['members'] == [{'student_id': '00-Ε😀', 'name': 'Ονομα e\u0301 😀'}]
    for model, body in [(s.EvidenceCreate, payload), (s.EvidencePatch, {'revision': 1, 'data': VALID_DATA})]:
        assert model.model_validate(body).data == VALID_DATA


@pytest.mark.parametrize('content_type', MEDIA_TYPES)
def test_malformed_session_token_is_sanitized_validation_not_auth_crash(client, content_type):
    assert_validation(raw_request(client, 'POST', '/api/v1/session', {'token': 'private-body-marker\ud800'}, content_type))
    ordinary = raw_request(client, 'POST', '/api/v1/session', {'token': 'Ελληνικά😀'})
    assert ordinary.status_code == 401 and ordinary.json()['code'] == 'auth'
    assert 'Ελληνικά' not in ordinary.text
    assert client.get('/api/v1/labs').status_code == 200


@pytest.fixture
def unicode_live(tmp_path):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    root = tmp_path / 'unicode-live'
    log_path = tmp_path / 'unicode-cli.log'
    with log_path.open('wb') as log:
        process = subprocess.Popen([sys.executable, '-m', 'lab_catalog', 'serve', '--data-dir', str(root), '--host', '127.0.0.1', '--port', str(port), '--allowed-host', f'127.0.0.1:{port}'], env=dict(os.environ, PYTHONPATH=str(Path(__file__).parents[1])), stdout=log, stderr=log)
        try:
            with httpx.Client(base_url=f'http://127.0.0.1:{port}', headers={'Connection': 'close'}, timeout=10) as c:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    assert process.poll() is None, log_path.read_text()
                    try:
                        if c.get('/health').status_code == 200:
                            break
                    except httpx.ConnectError:
                        pass
                    time.sleep(0.025)
                else:
                    pytest.fail('synthetic Unicode CLI did not become ready')
                c.headers['Authorization'] = 'Bearer ' + (root / 'operator-token').read_text().strip()
                yield c, root, log_path
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def database_snapshot(root):
    from lab_catalog.database import TABLES
    with sqlite3.connect(root / 'catalog.sqlite3') as db:
        return {table: db.execute(f'SELECT * FROM {table} ORDER BY rowid').fetchall() for table in TABLES}


def test_real_cli_unicode_containment_no_poison_rows_and_healthy_followup(unicode_live):
    c, root, log_path = unicode_live
    collection, payload, item, before, ex, team, base = evidence_records(c)
    initial = database_snapshot(root)
    responses = []
    for content_type in MEDIA_TYPES:
        for method in ['POST', 'PATCH']:
            for case in BAD_DATA:
                data = case.values[0]
                body = {**payload, 'data': data} if method == 'POST' else {'revision': 1, 'data': data}
                responses.append((f'{method}:{content_type}:{case.id}', raw_request(c, method, collection if method == 'POST' else item, body, content_type)))
        responses.extend([
            ('lab-title', raw_request(c, 'POST', '/api/v1/labs', {'title': 'private-body-marker\ud800'}, content_type)),
            ('team-notes', raw_request(c, 'PATCH', '/api/v1' + base + '/teams/' + team['id'], {'revision': 1, 'notes': 'private-body-marker\udfff'}, content_type)),
            ('member-name', raw_request(c, 'PATCH', '/api/v1' + base + '/teams/' + team['id'], {'revision': 1, 'members': [{'student_id': '00-Ε', 'name': '\ud800'}]}, content_type)),
            ('criterion-id', raw_request(c, 'PATCH', '/api/v1' + base + '/exercises/' + ex['id'], {'revision': 1, 'max_points': '1', 'grading_mode': 'criteria', 'criteria': [{'id': '\ud800', 'label': 'Healthy', 'max_points': '1'}]}, content_type)),
            ('assessment-notes', raw_request(c, 'PUT', gradepath(base, team, ex), {'revision': 0, 'rubric_revision': 1, 'notes': '\ud800'}, content_type)),
            ('session-token', raw_request(c, 'POST', '/api/v1/session', {'token': 'private-body-marker\ud800'}, content_type)),
        ])
    # Collect every response even in RED, proving values and keys over real HTTP.
    assert database_snapshot(root) == initial
    assert c.get(item).json() == before and c.get(collection).json()['total'] == 1
    healthy = raw_request(c, 'POST', collection, payload)
    assert healthy.status_code == 201 and healthy.json()['data'] == VALID_DATA
    assert c.get(collection + '/' + healthy.json()['id']).json() == healthy.json()
    assert c.get('/health').json() == {'status': 'ok'}
    failures = [(name, response.status_code) for name, response in responses if response.status_code != 422]
    assert not failures, failures
    for _, response in responses:
        assert_validation(response)
    assert 'Traceback' not in log_path.read_text()
