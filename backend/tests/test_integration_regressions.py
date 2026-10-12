"""Reproduced frontend/API contracts, using synthetic inert data only."""
import base64
from urllib.parse import quote
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from test_catalog import client, post, setup, gradepath, zipbytes


def test_create_criteria_without_ids_assigns_distinct_persisted_ids(client, tmp_path):
    from lab_catalog.api import create_app
    lab = post(client, '/labs', {'title': 'Generated IDs'})
    base = '/labs/' + lab['id']
    exercise = post(client, base + '/exercises', {
        'title': 'Rubric', 'grading_mode': 'criteria', 'max_points': '3',
        'criteria': [{'label': 'A', 'max_points': '1'},
                     {'label': 'B', 'max_points': '1'},
                     {'id': 'caller-literal-001', 'label': 'C', 'max_points': '1'}],
    })
    ids = [c['id'] for c in exercise['criteria']]
    assert len(set(ids)) == 3
    for generated in ids[:2]:
        assert str(UUID(generated)) == generated
    assert ids[2] == 'caller-literal-001'
    path = '/api/v1' + base + '/exercises/' + exercise['id']
    edited = client.patch(path, json={'revision': 1, 'title': 'Display edit', 'criteria': exercise['criteria']})
    assert edited.status_code == 200
    assert [c['id'] for c in edited.json()['criteria']] == ids
    assert edited.json()['rubric_revision'] == 1
    with TestClient(create_app(tmp_path / 'state', ['testserver'])) as restarted:
        restarted.headers.update(client.headers)
        assert [c['id'] for c in restarted.get(path).json()['criteria']] == ids


def test_patch_missing_ids_explicitly_replace_identities_without_score_remapping(client):
    _, exercise, team, base = setup(client, True)
    path = '/api/v1' + base + '/exercises/' + exercise['id']
    grade = gradepath(base, team, exercise)
    assert client.put(grade, json={'revision': 0, 'rubric_revision': 1, 'status': 'final', 'criterion_scores': {'clarity': '1', 'accuracy': '2'}}).status_code == 200
    criteria = [{k: v for k, v in criterion.items() if k != 'id'} for criterion in exercise['criteria']]
    response = client.patch(path, json={'revision': 1, 'criteria': criteria})
    assert response.status_code == 200
    ids = {x['id'] for x in response.json()['criteria']}
    assert len(ids) == 2 and not ids.intersection({'clarity', 'accuracy'})
    assert response.json()['rubric_revision'] == 2
    assert client.get(path).json() == response.json()
    old = client.get(grade).json()
    assert old['rubric_stale'] and old['criterion_scores'] == {'clarity': '1', 'accuracy': '2'}
    assert {x['id'] for x in old['rubric_snapshot']['criteria']} == {'clarity', 'accuracy'}


@pytest.mark.parametrize('path,data', [
    ('nested/café.html', 'UTF-8 café\n'.encode()),
    ('nested/raw.bin', b'\xff\x00\xfe\x80\n'),
    ('nested/hostile.html', b'<html><script>fetch("/api/v1/labs")</script></html>'),
])
def test_member_download_returns_original_inert_bytes_and_head_parity(client, path, data):
    _, _, team, base = setup(client)
    uploaded = client.post('/api/v1' + base + '/teams/' + team['id'] + '/submissions',
                           files={'file': ('synthetic.zip', zipbytes([(path, data)]))})
    assert uploaded.status_code == 201
    endpoint = '/api/v1/submissions/' + uploaded.json()['id'] + '/members/content'
    response = client.get(endpoint, params={'path': path})
    assert response.status_code == 200
    assert response.content == data
    assert response.headers['content-type'] == 'application/octet-stream'
    assert response.headers['content-disposition'] == "attachment; filename=download; filename*=UTF-8''" + quote(path.rsplit('/', 1)[-1], safe='')
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert response.headers['content-security-policy'] == "sandbox; default-src 'none'"
    assert response.headers['cache-control'] == 'no-store'
    head = client.head(endpoint, params={'path': path})
    assert head.status_code == 200 and head.content == b''
    for header in ('content-type', 'content-disposition', 'content-length', 'x-content-type-options', 'content-security-policy', 'cache-control'):
        assert head.headers[header] == response.headers[header]


@pytest.mark.parametrize('data', [b'hello UTF-8', b'\xff\x00', b'x' * (1024 * 1024 + 1)], ids=['utf8', 'binary', 'truncated'])
def test_member_text_preview_is_separate_typed_and_bounded(client, data):
    _, _, team, base = setup(client)
    uploaded = client.post('/api/v1' + base + '/teams/' + team['id'] + '/submissions',
                           files={'file': ('synthetic.zip', zipbytes([('source.txt', data)]))})
    assert uploaded.status_code == 201
    response = client.get('/api/v1/submissions/' + uploaded.json()['id'] + '/members/text', params={'path': 'source.txt'})
    assert response.status_code == 200
    preview = response.json()
    assert preview['size'] == len(data) and preview['path'] == 'source.txt'
    assert preview['truncated'] == (len(data) > 1024 * 1024)
    if data == b'\xff\x00':
        assert preview['text'] is None and base64.b64decode(preview['base64']) == data
    else:
        assert preview['text'].encode() == data[:1024 * 1024]
    schema = client.get('/openapi.json').json()
    route = schema['paths']['/api/v1/submissions/{submission_id}/members/text']['get']
    assert route['responses']['200']['content']['application/json']['schema']['$ref'].endswith('/TextContent')
    download = schema['paths']['/api/v1/submissions/{submission_id}/members/content']['get']
    assert download['responses']['200']['content']['application/octet-stream']['schema'] == {'type': 'string', 'format': 'binary'}


def test_partial_criterion_draft_persists_null_score_notes_history_and_staleness(client, tmp_path):
    from lab_catalog.api import create_app
    _, exercise, team, base = setup(client, True)
    endpoint = gradepath(base, team, exercise)
    payload = {'revision': 0, 'rubric_revision': 1, 'status': 'draft', 'score': None,
               'criterion_scores': {'clarity': '1.25'}, 'notes': 'Accuracy pending', 'source': 'human'}
    response = client.put(endpoint, json=payload)
    assert response.status_code == 200, response.text
    draft = response.json()
    assert draft['score'] is None and draft['criterion_scores'] == {'clarity': '1.25'}
    assert draft['notes'] == 'Accuracy pending'
    assert client.get(endpoint).json() == draft
    assert client.get(endpoint + '/history').json()['items'] == [draft]
    with TestClient(create_app(tmp_path / 'state', ['testserver'])) as restarted:
        restarted.headers.update(client.headers)
        assert restarted.get(endpoint).json() == draft
    assert client.patch('/api/v1' + base + '/exercises/' + exercise['id'],
                        json={'revision': 1, 'grading_instructions': 'New rubric'}).status_code == 200
    stale = client.get(endpoint).json()
    assert stale['rubric_stale'] and stale['score'] is None
    assert stale['criterion_scores'] == draft['criterion_scores']
    assert stale['rubric_snapshot'] == draft['rubric_snapshot']
    assert client.get(endpoint + '/history').json()['items'] == [stale]
    exported = client.get('/api/v1' + base + '/export').json()
    assert exported['assessments'] == [stale] and exported['assessment_history'] == [stale]
    complete = client.put(endpoint, json={'rubric_revision': 2, 'confirm_rubric_change': True, 'revision': 1, 'status': 'final',
                          'criterion_scores': {'clarity': '1.25', 'accuracy': '2'}, 'notes': 'Finished'})
    assert complete.status_code == 200 and complete.json()['score'] == '3.25'
    assert client.get(endpoint + '/history').json()['items'][0] == stale
    assert client.get('/api/v1' + base + '/overview').json()['rows'][0]['awarded_points'] == '3.25'


@pytest.mark.parametrize('supplied', ['0', '1.25', '9'])
def test_partial_draft_rejects_caller_aggregate_without_complete_criteria(client, supplied):
    _, exercise, team, base = setup(client, True)
    endpoint = gradepath(base, team, exercise)
    response = client.put(endpoint, json={'rubric_revision': 1, 'revision': 0, 'status': 'draft', 'score': supplied,
                                         'criterion_scores': {'clarity': '1.25'}})
    assert response.status_code == 422
    assert client.get(endpoint + '/history').json()['total'] == 0


@pytest.mark.parametrize('scores', [{'unknown': '1'}, {'clarity': '3.26'}, {'clarity': 'NaN'},
                                   {'clarity': 'Infinity'}, {'clarity': '-1'}, {'clarity': 1}])
def test_partial_draft_validates_each_supplied_criterion_without_writes(client, scores):
    _, exercise, team, base = setup(client, True)
    endpoint = gradepath(base, team, exercise)
    response = client.put(endpoint, json={'rubric_revision': 1, 'revision': 0, 'status': 'draft', 'criterion_scores': scores})
    assert response.status_code == 422
    assert client.get(endpoint).json()['revision'] == 0
    assert client.get(endpoint + '/history').json()['total'] == 0


def test_complete_criterion_draft_computes_exact_aggregate_and_rejects_inconsistent_sum(client):
    _, exercise, team, base = setup(client, True)
    endpoint = gradepath(base, team, exercise)
    scores = {'clarity': '1.25', 'accuracy': '2'}
    assert client.put(endpoint, json={'rubric_revision': 1, 'revision': 0, 'status': 'draft', 'score': '9', 'criterion_scores': scores}).status_code == 422
    response = client.put(endpoint, json={'rubric_revision': 1, 'revision': 0, 'status': 'draft', 'score': None, 'criterion_scores': scores})
    assert response.status_code == 200 and response.json()['score'] == '3.25'


def test_empty_ungraded_and_empty_draft_never_fabricate_scores(client):
    _, exercise, team, base = setup(client, True)
    endpoint = gradepath(base, team, exercise)
    for revision, status in enumerate(['ungraded', 'draft']):
        response = client.put(endpoint, json={'rubric_revision': 1, 'revision': revision, 'status': status, 'score': None, 'criterion_scores': {}, 'notes': ''})
        assert response.status_code == 200 and response.json()['score'] is None
        assert response.json()['criterion_scores'] == {}
    assert client.put(endpoint, json={'rubric_revision': 1, 'revision': 2, 'status': 'final', 'criterion_scores': {'clarity': '0'}}).status_code == 422


@pytest.mark.parametrize('auth', ['bearer', 'cookie'])
@pytest.mark.parametrize('origins', [['http://evil.invalid'], ['https://testserver'], ['http://testserver:80'], ['null'], ['http://testserver', 'http://testserver']])
def test_forbidden_origins_are_403_before_writes_without_session_invalidation(client, auth, origins):
    if auth == 'cookie':
        token = client.headers.pop('Authorization').removeprefix('Bearer ')
        assert client.post('/api/v1/session', json={'token': token}, headers={'Origin': 'http://testserver'}).status_code == 200
    headers = [('Origin', origin) for origin in origins]
    for method in ('GET', 'POST'):
        response = client.request(method, '/api/v1/labs', headers=headers,
                                  **({'json': {'title': 'Must not write'}} if method == 'POST' else {}))
        assert response.status_code == 403
        assert response.json()['code'] == 'forbidden_origin'
        assert 'set-cookie' not in response.headers
    assert client.get('/api/v1/labs').json()['total'] == 0
    assert client.get('/api/v1/session').json()['authenticated'] is True
    assert client.post('/api/v1/labs', json={'title': 'Still authenticated'}, headers={'Origin': 'http://testserver'}).status_code == 201


def test_origin_403_is_documented_and_auth_failures_remain_401(client):
    schema = client.get('/openapi.json').json()
    for method in ('get', 'post'):
        response = schema['paths']['/api/v1/labs'][method]['responses']['403']
        assert response['content']['application/json']['schema']['$ref'].endswith('/Error')
    client.headers.pop('Authorization')
    assert client.get('/api/v1/labs').status_code == 401
    assert client.get('/api/v1/labs', headers={'Authorization': 'Bearer invalid'}).status_code == 401


def test_cookie_mutation_missing_origin_is_forbidden_not_bad_auth(client):
    token = client.headers.pop('Authorization').removeprefix('Bearer ')
    assert client.post('/api/v1/session', json={'token': token}, headers={'Origin': 'http://testserver'}).status_code == 200
    response = client.post('/api/v1/labs', json={'title': 'Must not write'})
    assert response.status_code == 403 and response.json()['code'] == 'forbidden_origin'
    assert client.get('/api/v1/session').json()['authenticated'] is True
    assert client.get('/api/v1/labs').json()['total'] == 0
