import shlex
import sys

from test_ingest import Fixture


class HistoricalTests(Fixture):
    def setUp(self):
        super().setUp()
        self.archive()
        self.ingest()
        self.version = self.store.detail('lab-a')['teams'][0]['versions'][0]['id']
        self.name = self.store.detail('lab-a')['teams'][0]['versions'][0]['archive']
        self.legacy = {'archive': self.name, 'theory': {'overall': 'review_needed'},
                       'exercises': {'bs': {'passed': 18, 'total': 19}, 'substr': {'passed': 23, 'total': 25}}}

    def imported(self):
        self.assertTrue(hasattr(self.store, 'evidence_import'), 'historical evidence importer missing')
        return self.store.evidence_import('lab-a', {'groups': [{'id': 'old-group', 'versions': [self.legacy]}]})

    def test_exact_archive_linkage_keeps_historical_provenance_separate(self):
        self.assertEqual(self.imported(), {'imported': 1})
        version = self.store.detail('lab-a')['teams'][0]['versions'][0]
        self.assertEqual(version['status'], 'pending')
        self.assertIsNone(version['review'])
        self.assertEqual(version['evidence'], {'source': 'historical CSV (19/25 suite)', 'legacy': self.legacy})
        self.store.prepare('lab-a')
        bundle = self.store.bundle('lab-a', self.version)
        self.assertEqual(bundle['historicalEvidence']['legacy']['exercises']['substr']['total'], 25)
        self.assertIn('historical', bundle['instructions'])

    def test_duplicate_same_content_archives_receive_only_their_exact_evidence(self):
        first = self.src / 'submissions' / self.name
        duplicate = first.parent / (first.stem + '(1).zip')
        duplicate.write_bytes(first.read_bytes())
        self.ingest()
        self.imported()
        versions = self.store.detail('lab-a')['teams'][0]['versions']
        self.assertEqual(len(versions), 2)
        self.assertEqual(sum(v['evidence'] is not None for v in versions), 1)
        self.assertEqual(next(v for v in versions if v['evidence'])['archive'], self.name)

    def test_reject_unmapped_ambiguous_and_duplicate_historical_archives_before_writes(self):
        self.assertTrue(hasattr(self.store, 'evidence_import'), 'historical evidence importer missing')
        for reports in [[self.legacy, dict(self.legacy, archive='nope.zip')], [self.legacy, self.legacy]]:
            with self.assertRaises(ValueError):
                self.store.evidence_import('lab-a', reports)
            self.assertIsNone(self.store.detail('lab-a')['teams'][0]['versions'][0]['evidence'])
        self.archive(self.name, {'new.asm': 'different content'})
        self.ingest()
        with self.assertRaises(ValueError):
            self.store.evidence_import('lab-a', [self.legacy])
        self.assertEqual(self.store.evidence_import('lab-a', [self.legacy], versions={self.name: self.version}), {'imported': 1})

    def test_external_runner_preserves_legacy_without_changing_its_suite(self):
        self.imported()
        runner = self.base / 'review.py'
        runner.write_text('import json,sys\nb=json.load(sys.stdin)\nr={k:b[k] for k in ["schemaVersion","labId","teamId","versionId","inputHash"]}\nr.update(summary="fixture",exercises=[dict(id=e["id"],status="review_needed",summary="ask",findings=[],oralQuestions=[]) for e in b["exercises"]])\nprint(json.dumps(r))\n')
        self.store.review_run('lab-a', shlex.join([sys.executable, str(runner)]))
        evidence = self.store.detail('lab-a')['teams'][0]['versions'][0]['evidence']
        self.assertEqual(evidence['legacy'], self.legacy)
        self.assertEqual(evidence['run']['status'], 'succeeded')
        self.assertEqual(self.store.detail('lab-a')['teams'][0]['versions'][0]['status'], 'draft')
        self.imported()
        self.assertEqual(self.store.detail('lab-a')['teams'][0]['versions'][0]['evidence']['run']['status'], 'succeeded')

    def test_weights_are_metadata_not_permission_for_numerical_scores(self):
        self.manifest['rubric'] = {'one': {'weight': 2, 'policy': 'conversion not provided'}}
        self.ingest()
        self.assertIn('rubric', self.store.detail('lab-a'), 'rubric metadata missing from API')
        self.assertEqual(self.store.detail('lab-a')['rubric']['one']['weight'], 2)
        self.store.prepare('lab-a')
        value = self.store.bundle('lab-a', self.version)
        report = {'schemaVersion': 1, 'labId': 'lab-a', 'teamId': value['teamId'], 'versionId': self.version,
                  'inputHash': value['inputHash'], 'summary': 'fixture', 'exercises': [{'id': 'one', 'status': 'correct',
                  'summary': 'fixture', 'findings': [], 'oralQuestions': [], 'score': 2}]}
        with self.assertRaises(ValueError):
            self.store.review_import('lab-a', report)
