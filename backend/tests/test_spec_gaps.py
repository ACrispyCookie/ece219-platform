"""Synthetic regression tests for catalog correction and rubric review contracts."""
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from test_catalog import client, setup, post, gradepath, upload, zipbytes
from test_hardening import live


def test_live_cli_correction_and_loaded_rubric_contracts(live):
    c, _, _ = live
    ex, team, base, _, _, _, material_path, evidence_path = records(c)
    for path in [material_path, evidence_path]:
        before = c.get(path)
        assert before.status_code == 200
        changed = c.patch(path, json={'revision': 1, 'title': 'Live correction'})
        assert changed.status_code == 200
        assert c.get(path).json() == changed.json()
        assert c.patch(path, json={'revision': 1, 'title': 'Race'}).status_code == 409
    grade = gradepath(base, team, ex)
    assert c.put(grade, json={'revision': 0, 'rubric_revision': 1, 'score': '1', 'status': 'final'}).status_code == 200
    assert c.patch('/api/v1' + base + '/exercises/' + ex['id'], json={'revision': 1, 'grading_instructions': 'Changed'}).status_code == 200
    rejected = c.put(grade, json={'revision': 1, 'rubric_revision': 1, 'score': '1', 'status': 'final'})
    assert rejected.status_code == 409
    notes = c.put(grade, json={'revision': 1, 'rubric_revision': 2, 'score': '1', 'status': 'final', 'notes': 'Keep stale'})
    assert notes.status_code == 200 and notes.json()['rubric_stale']
    assert c.get(grade).json() == notes.json()


@pytest.mark.parametrize('kind,fields', [
    ('text', {'text': 'Corrected observation', 'url': None, 'file_id': None, 'data': None}),
    ('link', {'url': 'https://example.invalid/corrected'}),
    ('file', {}),
    ('result', {'data': [False, {'value': 2}]}),
])
def test_evidence_corrections_accept_each_kind_and_same_owner_references(client, kind, fields):
    ex, team, base, f, _, evidence, _, path = records(client)
    new_ex = post(client, base + '/exercises', {'title': 'Other exercise'})
    submission = client.post('/api/v1' + base + '/teams/' + team['id'] + '/submissions', files={'file': ('s.zip', zipbytes([('a', b'a')]))}).json()
    response = client.patch(path, json={'revision': 1, 'exercise_id': new_ex['id'], 'submission_id': submission['id'], 'kind': kind, 'source': 'agent', **fields})
    assert response.status_code == 200, response.text
    changed = response.json()
    assert changed['id'] == evidence['id'] and changed['revision'] == 2
    assert changed['exercise_id'] == new_ex['id'] and changed['submission_id'] == submission['id']
    assert changed['source'] == 'agent'
    assert client.get(path).json() == changed
    assert client.get(gradepath(base, team, ex)).json()['score'] is None


def test_material_correction_updates_description_and_same_lab_exercise(client):
    _, _, base, _, material, _, path, _ = records(client)
    exercise = post(client, base + '/exercises', {'title': 'Other'})
    response = client.patch(path, json={'revision': 1, 'exercise_id': exercise['id'], 'description': 'Correction'})
    assert response.status_code == 200
    updated = response.json()
    assert updated['exercise_id'] == exercise['id'] and updated['description'] == 'Correction'
    assert updated['title'] == material['title'] and updated['file_id'] == material['file_id']
    assert client.get(path).json() == updated


def test_patch_mixes_existing_and_new_criterion_identities(client):
    _, ex, team, base = setup(client, True)
    path = '/api/v1' + base + '/exercises/' + ex['id']
    assert client.put(gradepath(base, team, ex), json={'revision': 0, 'rubric_revision': 1, 'status': 'final', 'criterion_scores': {'clarity': '1', 'accuracy': '2'}}).status_code == 200
    criteria = [ex['criteria'][0], {'label': 'New check', 'max_points': '1'}, ex['criteria'][1]]
    response = client.patch(path, json={'revision': 1, 'max_points': '11.25', 'criteria': criteria})
    assert response.status_code == 200, response.text
    updated = response.json()
    ids = [x['id'] for x in updated['criteria']]
    assert ids[0] == 'clarity' and ids[2] == 'accuracy'
    assert str(UUID(ids[1])) == ids[1]
    assert client.get(path).json() == updated
    assert updated['rubric_revision'] == 2
    old = client.get(gradepath(base, team, ex)).json()
    assert old['rubric_stale'] and old['criterion_scores'] == {'clarity': '1', 'accuracy': '2'}


def test_patch_manual_to_criteria_allocates_ids(client):
    _, ex, _, base = setup(client)
    response = client.patch('/api/v1' + base + '/exercises/' + ex['id'], json={
        'revision': 1, 'grading_mode': 'criteria', 'criteria': [{'label': 'Check', 'max_points': '10.25'}]})
    assert response.status_code == 200, response.text
    assert response.json()['criteria'][0]['id']
    assert response.json()['rubric_revision'] == 2


def test_label_change_is_semantic_but_order_and_exercise_display_are_not(client):
    _, ex, team, base = setup(client, True)
    grade = gradepath(base, team, ex)
    assert client.put(grade, json={'revision': 0, 'rubric_revision': 1, 'status': 'final', 'criterion_scores': {'clarity': '1', 'accuracy': '2'}}).status_code == 200
    path = '/api/v1' + base + '/exercises/' + ex['id']
    reordered = list(reversed(ex['criteria']))
    cosmetic = client.patch(path, json={'revision': 1, 'title': 'Display', 'description': 'Only display', 'criteria': reordered}).json()
    assert cosmetic['rubric_revision'] == 1 and not client.get(grade).json()['rubric_stale']
    reordered[0]['label'] = 'Documentation'
    semantic = client.patch(path, json={'revision': 2, 'criteria': reordered}).json()
    assert semantic['rubric_revision'] == 2
    assert client.get(grade).json()['rubric_stale']


@pytest.mark.parametrize('payload', [{'revision': 0}, {'revision': 0, 'rubric_revision': 0}, {'revision': 0, 'rubric_revision': None}])
def test_assessment_requires_loaded_rubric_revision(client, payload):
    _, ex, team, base = setup(client)
    response = client.put(gradepath(base, team, ex), json=payload)
    assert response.status_code == 422
    assert client.get(gradepath(base, team, ex) + '/history').json()['total'] == 0


@pytest.mark.parametrize('existing', [False, True])
@pytest.mark.parametrize('notes_only', [False, True])
def test_old_editor_rubric_race_rejected_even_first_assessment_and_notes(client, existing, notes_only):
    _, ex, team, base = setup(client)
    path = gradepath(base, team, ex)
    if existing:
        assert client.put(path, json={'revision': 0, 'rubric_revision': 1, 'notes': 'Loaded'}).status_code == 200
    assert client.patch('/api/v1' + base + '/exercises/' + ex['id'], json={'revision': 1, 'grading_instructions': 'Changed'}).status_code == 200
    payload = {'revision': int(existing), 'rubric_revision': 1, 'notes': 'Old editor'}
    if not notes_only: payload.update(status='final', score='2')
    response = client.put(path, json=payload)
    assert response.status_code == 409, response.text
    assert client.get(path).json()['revision'] == int(existing)
    assert client.get(path + '/history').json()['total'] == int(existing)


@pytest.mark.parametrize('criteria', [False, True])
def test_stale_notes_preserve_snapshot_score_and_require_conscious_regrade(client, criteria):
    _, ex, team, base = setup(client, criteria)
    path = gradepath(base, team, ex)
    fields = {'criterion_scores': {'clarity': '3', 'accuracy': '6'}, 'score': None} if criteria else {'score': '9'}
    first = client.put(path, json={'revision': 0, 'rubric_revision': 1, 'status': 'final', **fields}).json()
    changes = {'max_points': '1', 'grading_mode': 'manual', 'criteria': []}
    assert client.patch('/api/v1' + base + '/exercises/' + ex['id'], json={'revision': 1, **changes}).status_code == 200
    notes_fields = {'criterion_scores': {'accuracy': '6.0', 'clarity': '3.000'}, 'score': None} if criteria else {'score': '9.000'}
    response = client.put(path, json={'revision': 1, 'rubric_revision': 2, 'status': 'final', 'notes': 'Just notes', 'source': 'agent', **notes_fields})
    assert response.status_code == 200, response.text
    retained = response.json()
    assert retained['rubric_stale'] and retained['rubric_revision'] == 1
    assert retained['score'] == first['score'] and retained['criterion_scores'] == first['criterion_scores']
    assert retained['rubric_snapshot'] == first['rubric_snapshot'] and retained['notes'] == 'Just notes'
    assert 'confirm_rubric_change' not in retained
    assert client.get(path).json() == retained
    assert not client.get('/api/v1' + base + '/overview').json()['rows'][0]['grade_complete']
    regrade = {'revision': 2, 'rubric_revision': 2, 'status': 'final', 'score': '1'}
    rejected = client.put(path, json=regrade)
    assert rejected.status_code == 409, rejected.text
    assert client.get(path).json() == retained
    reviewed = client.put(path, json={**regrade, 'confirm_rubric_change': True})
    assert reviewed.status_code == 200, reviewed.text
    assert not reviewed.json()['rubric_stale'] and reviewed.json()['rubric_revision'] == 2
    assert reviewed.json()['rubric_snapshot']['max_points'] == '1'
    assert 'confirm_rubric_change' not in reviewed.json()
    assert client.get(path + '/history').json()['total'] == 3
    assert client.get('/api/v1' + base + '/overview').json()['rows'][0]['grade_complete']


def test_stale_grading_changes_require_confirmation_before_write(client):
    _, ex, team, base = setup(client)
    path = gradepath(base, team, ex)
    assert client.put(path, json={'revision': 0, 'rubric_revision': 1, 'status': 'final', 'score': '2'}).status_code == 200
    assert client.patch('/api/v1' + base + '/exercises/' + ex['id'], json={'revision': 1, 'grading_instructions': 'Review'}).status_code == 200
    before = client.get(path).json()
    response = client.put(path, json={'revision': 1, 'rubric_revision': 2, 'status': 'final', 'score': '3'})
    assert response.status_code == 409
    assert client.get(path).json() == before
    assert client.get(path + '/history').json()['total'] == 1


def test_confirmation_regrades_unchanged_values_under_current_rubric(client):
    _, ex, team, base = setup(client, True)
    path = gradepath(base, team, ex)
    payload = {'rubric_revision': 1, 'status': 'final', 'criterion_scores': {'clarity': '1', 'accuracy': '2'}}
    first = client.put(path, json={'revision': 0, **payload}).json()
    assert client.patch('/api/v1' + base + '/exercises/' + ex['id'], json={'revision': 1, 'grading_instructions': 'Review'}).status_code == 200
    response = client.put(path, json={'revision': 1, **payload, 'rubric_revision': 2, 'confirm_rubric_change': True})
    assert response.status_code == 200, response.text
    assert not response.json()['rubric_stale']
    assert response.json()['rubric_snapshot'] != first['rubric_snapshot']


def records(client):
    _, ex, team, base = setup(client)
    f = upload(client, base).json()
    material = post(client, base + '/materials', {'file_id': f['id'], 'exercise_id': ex['id'], 'role': 'handout', 'title': 'Material', 'description': 'Keep'})
    evidence_base = base + '/teams/' + team['id'] + '/evidence'
    evidence = post(client, evidence_base, {'exercise_id': ex['id'], 'kind': 'text', 'title': 'Evidence', 'text': 'Keep', 'url': 'https://example.invalid/', 'file_id': f['id'], 'data': {'old': 1}})
    return ex, team, base, f, material, evidence, '/api/v1' + base + '/materials/' + material['id'], '/api/v1' + evidence_base + '/' + evidence['id']


def test_material_detail_patch_revision_and_stable_identity(client):
    ex, _, base, f, material, _, path, _ = records(client)
    assert material['revision'] == 1
    assert 'created_at' not in material
    assert client.get(path).json() == material
    replacement = upload(client, base, data=b'new').json()
    response = client.patch(path, json={'revision': 1, 'file_id': replacement['id'], 'exercise_id': None, 'role': 'grader', 'title': 'Corrected'})
    assert response.status_code == 200, response.text
    changed = response.json()
    assert changed['id'] == material['id'] and changed['revision'] == 2
    assert changed['description'] == 'Keep' and changed['exercise_id'] is None
    assert changed['file_id'] == replacement['id'] and changed['role'] == 'grader'
    assert client.get(path).json() == changed
    conflict = client.patch(path, json={'revision': 1, 'title': 'Overwrite'})
    assert conflict.status_code == 409 and set(conflict.json()) == {'code', 'message', 'details'}
    assert client.get(path).json() == changed


def test_evidence_detail_patch_preserves_identity_and_nullable_clearing(client):
    _, _, _, _, _, evidence, _, path = records(client)
    assert evidence['revision'] == 1
    assert client.get(path).json() == evidence
    response = client.patch(path, json={'revision': 1, 'title': 'Corrected', 'kind': 'result', 'text': '', 'url': None, 'file_id': None, 'submission_id': None, 'data': {'new': [False, 2]}, 'source': 'import'})
    assert response.status_code == 200, response.text
    changed = response.json()
    assert changed['revision'] == 2 and changed['id'] == evidence['id']
    assert changed['created_at'] == evidence['created_at']
    assert changed['exercise_id'] == evidence['exercise_id']
    assert changed['source'] == 'import' and changed['data'] == {'new': [False, 2]}
    assert changed['url'] is None and changed['file_id'] is None
    assert client.get(path).json() == changed
    assert client.patch(path, json={'revision': 1, 'text': 'Overwrite'}).status_code == 409
    assert client.get(path).json() == changed


@pytest.mark.parametrize('target,field,value', [
    ('material', 'id', 'new'), ('material', 'lab_id', 'new'), ('material', 'title', None),
    ('material', 'description', None), ('material', 'file_id', None), ('material', 'role', None),
    ('material', 'role', 'invalid'), ('material', 'title', ''),
    ('evidence', 'id', 'new'), ('evidence', 'lab_id', 'new'), ('evidence', 'team_id', 'new'),
    ('evidence', 'exercise_id', None), ('evidence', 'kind', None), ('evidence', 'title', None),
    ('evidence', 'text', None), ('evidence', 'source', None), ('evidence', 'kind', 'invalid'),
    ('evidence', 'source', 'admin'), ('evidence', 'url', 'javascript:bad'),
    ('evidence', 'text', ''),
])
def test_record_patch_rejects_invalid_unknown_and_nonnullable_fields(client, target, field, value):
    *_, material_path, evidence_path = records(client)
    path = material_path if target == 'material' else evidence_path
    before = client.get(path)
    assert before.status_code == 200
    response = client.patch(path, json={'revision': 1, field: value})
    assert response.status_code == 422, response.text
    assert set(response.json()) == {'code', 'message', 'details'}
    assert client.get(path).json() == before.json()


@pytest.mark.parametrize('target', ['material', 'evidence'])
def test_record_patch_requires_revision(client, target):
    *_, material_path, evidence_path = records(client)
    path = material_path if target == 'material' else evidence_path
    assert client.patch(path, json={'title': 'No revision'}).status_code == 422


def test_record_patch_rechecks_references_and_detail_ownership(client):
    ex, team, base, _, material, evidence, mp, ep = records(client)
    _, other_ex, other_team, other_base = setup(client)
    foreign_file = upload(client, other_base).json()
    same_lab_team = post(client, base + '/teams', {'label': 'Other'})
    team_file = upload(client, base, team=same_lab_team['id']).json()
    subpath = '/api/v1' + base + '/teams/' + same_lab_team['id'] + '/submissions'
    foreign_sub = client.post(subpath, files={'file': ('s.zip', zipbytes([('a', b'a')]))}).json()
    for path, fields in [(mp, {'file_id': foreign_file['id']}), (mp, {'file_id': team_file['id']}), (mp, {'exercise_id': other_ex['id']}),
                         (ep, {'exercise_id': other_ex['id']}), (ep, {'file_id': foreign_file['id']}), (ep, {'file_id': team_file['id']}), (ep, {'submission_id': foreign_sub['id']})]:
        assert client.patch(path, json={'revision': 1, **fields}).status_code == 422
    wrong_mp = '/api/v1' + other_base + '/materials/' + material['id']
    wrong_ep = '/api/v1' + base + '/teams/' + same_lab_team['id'] + '/evidence/' + evidence['id']
    wrong_lab_ep = '/api/v1' + other_base + '/teams/' + other_team['id'] + '/evidence/' + evidence['id']
    for path in [wrong_mp, wrong_ep, wrong_lab_ep]:
        assert client.get(path).status_code == 404
        assert client.patch(path, json={'revision': 1, 'title': 'Wrong owner'}).status_code == 404
    assert client.get(mp).json() == material and client.get(ep).json() == evidence


def test_correction_contracts_are_typed_in_openapi(client):
    schema = client.get('/openapi.json').json()
    for path, model in [('/api/v1/labs/{lab_id}/materials/{material_id}', 'Material'), ('/api/v1/labs/{lab_id}/teams/{team_id}/evidence/{evidence_id}', 'Evidence')]:
        for method in ['get', 'patch']:
            assert schema['paths'][path][method]['responses']['200']['content']['application/json']['schema']['$ref'].endswith('/' + model)
        assert schema['paths'][path]['patch']['requestBody']['content']['application/json']['schema']['$ref'].endswith('/' + model + 'Patch')
        patch = schema['components']['schemas'][model + 'Patch']
        assert patch['required'] == ['revision'] and patch['additionalProperties'] is False
    put = schema['components']['schemas']['AssessmentPut']
    assert 'rubric_revision' in put['required'] and put['properties']['rubric_revision']['minimum'] == 1
    assert put['properties']['confirm_rubric_change']['default'] is False
    assert 'confirm_rubric_change' not in schema['components']['schemas']['Assessment']['properties']


def test_version_one_records_migrate_and_corrections_survive_restart(client, tmp_path):
    from lab_catalog.api import create_app
    _, _, _, _, material, evidence, mp, ep = records(client)
    cat = client.app.state.catalog
    with cat.db.connect(write=True) as db:
        for table, record in [('materials', material), ('evidence', evidence)]:
            db.execute(f"UPDATE {table} SET data=json_remove(data,'$.revision','$.updated_at') WHERE id=?", (record['id'],))
        db.execute('PRAGMA user_version=1')
    with TestClient(create_app(tmp_path / 'state', ['testserver'])) as restarted:
        restarted.headers.update(client.headers)
        for path in [mp, ep]:
            migrated = restarted.get(path)
            assert migrated.status_code == 200, migrated.text
            assert migrated.json()['revision'] == 1
            changed = restarted.patch(path, json={'revision': 1, 'title': 'Migrated correction'})
            assert changed.status_code == 200 and changed.json()['revision'] == 2
        with restarted.app.state.catalog.db.connect() as db:
            assert db.execute('PRAGMA user_version').fetchone()[0] == 2
    with TestClient(create_app(tmp_path / 'state', ['testserver'])) as again:
        again.headers.update(client.headers)
        for path in [mp, ep]:
            record = again.get(path).json()
            assert record['revision'] == 2 and record['title'] == 'Migrated correction'
        assert 'created_at' not in again.get(mp).json()
        assert again.get(ep).json()['created_at'] == evidence['created_at']
