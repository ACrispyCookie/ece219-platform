import copy
import json
from pathlib import Path

from test_ingest import Fixture


class CurrentEvidenceTests(Fixture):
    def setUp(self):
        super().setUp()
        self.archive()
        self.ingest()
        self.record = self.store.manifest('lab-a')['versions'][0]
        self.version = self.record['id']
        self.source = self.record['files'][0]

    def run_result(self):
        from ece218.core import sha
        return {'schema_version': 1, 'mode': 'function', 'exercise': 'one', 'function': 'entry',
                'source': {'path': str(self.store.file_path('lab-a', self.version, self.source)),
                           'sha256': sha(self.store.file_path('lab-a', self.version, self.source))},
                'status': 'completed', 'total': 1, 'passed': 0,
                'tests': [{'index': 1, 'status': 'fail', 'expected': [2], 'got': 1}],
                'not_evaluated': ['ABI preservation', 'console behaviour', 'numeric final marks']}

    def attach(self, data=None):
        self.assertTrue(hasattr(self.store, 'run_import'), 'fresh run evidence import is missing')
        return self.store.run_import('lab-a', self.version, self.source, data or self.run_result())

    def test_current_evidence_is_immutable_distinct_and_visible_without_agent_review(self):
        one = self.attach()
        self.assertEqual(one['imported'], 1)
        self.attach()
        detail = self.store.detail('lab-a')['teams'][0]['versions'][0]
        self.assertEqual(detail['status'], 'pending')
        self.assertEqual(len(detail['testEvidence']), 1)
        self.assertEqual(detail['testEvidence'][0]['result']['passed'], 0)
        self.assertEqual(detail['testEvidence'][0]['sourcePath'], 'submissions/' + self.version + '/' + self.source)
        self.assertIn('/runs/', detail['testEvidence'][0]['url'])
        changed = self.run_result()
        changed['tests'][0]['got'] = 2
        changed['tests'][0]['status'] = 'pass'
        changed['passed'] = 1
        self.attach(changed)
        self.assertEqual(len(self.store.detail('lab-a')['teams'][0]['versions'][0]['testEvidence']), 2)

    def test_current_evidence_is_hash_bound_and_citable_in_review_bundle(self):
        self.store.prepare('lab-a')
        before = self.store.bundle('lab-a', self.version)['inputHash']
        self.attach()
        with self.assertRaisesRegex(ValueError, 'stale'):
            self.store.bundle('lab-a', self.version)
        self.store.prepare('lab-a')
        bundle = self.store.bundle('lab-a', self.version)
        self.assertNotEqual(before, bundle['inputHash'])
        artifact = bundle['automatedEvidence'][0]
        self.assertEqual(artifact['trust'], 'recorded_execution_evidence')
        lines = artifact['content'].splitlines()
        line = next(i for i, text in enumerate(lines, 1) if '"got": 1' in text)
        report = {'schemaVersion': 1, 'labId': 'lab-a', 'teamId': bundle['teamId'], 'versionId': self.version,
                  'inputHash': bundle['inputHash'], 'summary': 'Draft from recorded run',
                  'exercises': [{'id': 'one', 'status': 'partial', 'summary': 'Recorded return differs',
                    'findings': [{'severity': 'warning', 'message': 'Recorded return differs',
                       'citations': [{'path': artifact['path'], 'line': line, 'quote': '"got": 1'}]}],
                    'oralQuestions': []}]}
        self.assertEqual(self.store.validate_review('lab-a', report)['status'], 'draft')

    def test_source_hash_identity_and_inconsistent_tests_rejected_before_write(self):
        self.assertTrue(hasattr(self.store, 'run_import'), 'fresh run evidence import is missing')
        result = self.run_result()
        bad_cases = []
        bad = copy.deepcopy(result); bad['source']['sha256'] = '0' * 64; bad_cases.append(bad)
        bad = copy.deepcopy(result); bad['source']['path'] = '/unrelated.asm'; bad_cases.append(bad)
        bad = copy.deepcopy(result); bad['exercise'] = 'unknown'; bad_cases.append(bad)
        bad = copy.deepcopy(result); bad['passed'] = 1; bad_cases.append(bad)
        bad = copy.deepcopy(result); bad['total'] = 2; bad_cases.append(bad)
        bad = copy.deepcopy(result); bad['tests'][0]['status'] = 'not-real'; bad_cases.append(bad)
        for bad in bad_cases:
            with self.subTest(result=bad), self.assertRaises(ValueError):
                self.attach(bad)
        self.assertEqual(self.store.detail('lab-a')['teams'][0]['versions'][0]['testEvidence'], [])

    def test_missing_source_and_zero_run_adapter_error_are_not_algorithm_failures(self):
        self.assertTrue(hasattr(self.store, 'run_import'), 'fresh run evidence import is missing')
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.store.run_import('lab-a', self.version, '../outside', self.run_result())
        result = self.run_result()
        result.update(status='adapter_error', passed=None, total=1, tests=[], error='label unavailable')
        self.attach(result)
        item = self.store.detail('lab-a')['teams'][0]['versions'][0]['testEvidence'][0]
        self.assertIsNone(item['result']['passed'])
        self.assertEqual(item['result']['status'], 'adapter_error')

    def test_changed_test_source_invalidates_run_import_bundle_and_review(self):
        self.attach()
        self.store.prepare('lab-a')
        original_run = self.run_result()
        source = self.store.file_path('lab-a', self.version, self.source)
        source.write_text('changed\n')
        with self.assertRaises(ValueError):
            self.store.bundle('lab-a', self.version)
        with self.assertRaises(ValueError):
            self.attach(original_run)
