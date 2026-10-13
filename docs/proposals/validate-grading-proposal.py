"""Validate a proposed OpenAPI document and illustrative requests; no server calls."""
from pathlib import Path
from collections import Counter
import json
import re
import sys
from openapi_spec_validator import validate_spec
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent
spec = json.loads((root / 'grading-api.openapi.json').read_text())
validate_spec(spec)
refs = []
def walk(value):
    if isinstance(value, dict):
        if '$ref' in value:
            pointer = value['$ref']
            assert pointer.startswith('#/'), 'Only internal contract references permitted'
            target = spec
            for part in pointer[2:].split('/'):
                target = target[part.replace('~1', '/').replace('~0', '~')]
            refs.append(pointer)
        for child in value.values():
            walk(child)
    elif isinstance(value, list):
        for child in value:
            walk(child)
walk(spec)
operation_ids = []
roles = Counter()
for path, methods in spec['paths'].items():
    for method, operation in methods.items():
        assert method in ('get', 'post', 'put', 'delete')
        operation_ids.append(operation['operationId'])
        roles[operation['x-authority']] += 1
        expected = set(re.findall(r'{([^}]+)}', path))
        declared = {p['name'] for p in operation['parameters'] if p['in'] == 'path' and p['required']}
        assert expected == declared, (path, expected, declared)
        assert operation['security'] and operation['responses']
assert len(operation_ids) == len(set(operation_ids))
for schema in spec['components']['schemas'].values():
    Draft202012Validator.check_schema(schema)

cases = [
    ('run-explicit-version', 'RunCreate', {'team_id':'team-id','exercise_id':'exercise-id','submission_id':'submission-id','mode':'hybrid','rubric_revision':4,'grading_plan_id':'plan-id','input_bindings':[{'name':'source','member_paths':['folder/main.s']}]}, True),
    ('run-missing-submission', 'RunCreate', {'team_id':'team-id','exercise_id':'exercise-id','mode':'hybrid','rubric_revision':4,'grading_plan_id':'plan-id'}, False),
    ('run-no-host-command', 'RunCreate', {'team_id':'team-id','exercise_id':'exercise-id','submission_id':'submission-id','mode':'hybrid','rubric_revision':4,'grading_plan_id':'plan-id','command':'arbitrary command'}, False),
    ('activate-current-preconditions', 'BindPlan', {'exercise_revision':5,'rubric_revision':4,'grading_plan_id':'plan-id','approve_execution':True}, True),
    ('accept-proposal-explicit-notes', 'AcceptProposal', {'revision':1,'assessment_revision':0,'rubric_revision':5,'grading_plan_id':'plan-id','acknowledge_assessment_change':False,'status':'final','scores':{'kind':'proposal'},'notes':'Reviewed','assessment_id':None,'assessment_slot_generation':0}, True),
    ('accept-criteria-decimal-strings', 'AcceptProposal', {'revision':1,'assessment_revision':2,'rubric_revision':5,'grading_plan_id':'plan-id','acknowledge_assessment_change':True,'status':'final','scores':{'kind':'criteria','criterion_scores':{'correctness':'2.00','explanation':'1.00'}},'notes':'Reviewed','assessment_id':'assessment-id','assessment_slot_generation':1}, True),
    ('reject-float-score', 'CriteriaReplacement', {'kind':'criteria','criterion_scores':{'correctness':2.0}}, False),
    ('reject-ambiguous-score-selection', 'ScoreSelection', {'kind':'proposal','score':'3.00'}, False),
    ('agent-cannot-claim-automatic-owner', 'AgentCriterionEvaluation', {'criterion_id':'correctness','evaluator':'automatic','points':'2','status':'resolved','explanation':'Untrusted claim','evidence':[]}, False),
    ('check-approved-selector-shape', 'CheckRequest', {'check_group':'edge-cases'}, True),
    ('check-reject-command', 'CheckRequest', {'check_group':'edge-cases','command':'arbitrary command'}, False),
    ('claim-explicit-identity', 'ClaimRequest', {'claim_id':'0a9262a5-a146-4e9a-91b1-a6eb97f07336','kinds':['automatic'],'runner_ids':['approved-runner']}, True),
    ('heartbeat-no-secret-fields', 'Heartbeat', {'stage':'Checking output','progress':None}, True),
    ('agent-unresolved-is-null', 'AgentCriterionEvaluation', {'criterion_id':'explanation','evaluator':'agent','points':None,'status':'unresolved','explanation':'Evidence insufficient','evidence':[]}, True),
    ('agent-resolved-needs-score', 'AgentCriterionEvaluation', {'criterion_id':'explanation','evaluator':'agent','points':None,'status':'resolved','explanation':'Incomplete result','evidence':[]}, False),
    ('cleanup-ack-only-after-termination', 'CleanupAck', {'claim_id':'0a9262a5-a146-4e9a-91b1-a6eb97f07336','fence':1,'processes_terminated':True,'termination_note':'Supervisor waited for process tree'}, True),
    ('cleanup-cannot-claim-still-running', 'CleanupAck', {'claim_id':'0a9262a5-a146-4e9a-91b1-a6eb97f07336','fence':1,'processes_terminated':False,'termination_note':'Still running'}, False),
    ('heartbeat-refuses-admin-fields', 'Heartbeat', {'stage':'Checking output','progress':None,'operator_token':'not-a-real-secret'}, False),
]
results = []
registry = Registry().with_resource('urn:grading:proposal', Resource.from_contents({'$schema':'https://json-schema.org/draft/2020-12/schema', **spec}))
for name, model, body, expected in cases:
    validator = Draft202012Validator({'$ref':'urn:grading:proposal#/components/schemas/'+model}, registry=registry)
    errors = list(validator.iter_errors(body))
    actual = not errors
    assert actual == expected, (name, [e.message for e in errors])
    results.append({'case':name,'schema':model,'expected_valid':expected,'passed':True})
report = {
    'status':'proposed-contract-validated-not-implemented',
    'openapi_version':spec['openapi'],
    'operations':len(operation_ids),
    'paths':len(spec['paths']),
    'component_schemas':len(spec['components']['schemas']),
    'resolved_internal_refs':len(refs),
    'operations_by_authority':dict(roles),
    'illustrative_schema_cases':results,
    'limits':'Schema/structure validation only; service-level ownership, decimal range, compatibility, concurrency and sandbox behavior require implementation tests after approval.',
    'application_source_modified':False,
    'live_api_called':False,
}
(root / 'grading-api.validation.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({k:v for k,v in report.items() if k != 'illustrative_schema_cases'}, indent=2))
print('Illustrative schema cases passed:', len(results))
