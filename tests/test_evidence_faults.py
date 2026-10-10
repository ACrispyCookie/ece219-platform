import copy
from pathlib import Path

from test_ingest import Fixture
from ece218.core import sha


class EvidenceFaultTests(Fixture):
    def setUp(self):
        super().setUp()
        self.archive(members={'src/main.asm': '.include "helpers/defs.asm"\nentry:\n ret\n',
                              'src/helpers/defs.asm': '.eqv VALUE 1\n'})
        self.ingest()
        self.version = self.store.manifest('lab-a')['versions'][0]['id']
        self.member = 'src/main.asm'
        main = self.store.file_path('lab-a', self.version, self.member)
        helper = self.store.file_path('lab-a', self.version, 'src/helpers/defs.asm')
        self.result = {'schema_version': 1, 'mode': 'function', 'exercise': 'one', 'function': 'entry',
            'source': {'path': str(main), 'sha256': sha(main), 'includes': [
                {'path': 'main.asm', 'sha256': sha(main), 'bytes': main.stat().st_size},
                {'path': 'helpers/defs.asm', 'sha256': sha(helper), 'bytes': helper.stat().st_size}]},
            'status': 'completed', 'total': 1, 'passed': 1,
            'tests': [{'index': 1, 'status': 'pass', 'expected': [1], 'got': 1}]}

    def attach(self, result=None):
        return self.store.run_import('lab-a', self.version, self.member, result or self.result)

    def test_helper_change_invalidates_import_readback_and_fresh_bundle(self):
        self.attach()
        helper = self.store.file_path('lab-a', self.version, 'src/helpers/defs.asm')
        helper.write_text('.eqv VALUE 99\n')
        with self.assertRaisesRegex(ValueError, 'include'):
            self.attach()
        with self.assertRaisesRegex(ValueError, 'include'):
            self.store.test_evidence('lab-a', self.version)
        self.assertEqual(self.store.prepare('lab-a')['prepared'], 0)

    def test_include_records_are_safe_complete_unique_and_exact(self):
        mutations = [
            lambda r: r['source']['includes'][1].update(path='../outside.asm'),
            lambda r: r['source']['includes'][1].update(path='/absolute.asm'),
            lambda r: r['source']['includes'][1].update(sha256='0' * 64),
            lambda r: r['source']['includes'][1].update(bytes=999),
            lambda r: r['source']['includes'].pop(),
            lambda r: r['source']['includes'].append(copy.deepcopy(r['source']['includes'][0])),
            lambda r: r['source'].pop('includes'),
        ]
        for mutate in mutations:
            bad = copy.deepcopy(self.result)
            mutate(bad)
            with self.subTest(result=bad), self.assertRaises(ValueError):
                self.attach(bad)
        self.assertEqual(self.store.test_evidence('lab-a', self.version), [])

    def test_missing_or_symlinked_include_is_rejected(self):
        helper = self.store.file_path('lab-a', self.version, 'src/helpers/defs.asm')
        helper.unlink()
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.attach()
        helper.symlink_to(self.src / 'rubric.txt')
        with self.assertRaises(ValueError):
            self.attach()

    def test_one_stale_run_is_visible_as_error_without_hiding_other_labs_or_notes(self):
        self.attach()
        self.store.prepare('lab-a')
        team = self.store.detail('lab-a')['teams'][0]['id']
        note = {'text': 'Preserve human work', 'decision': 'pending'}
        self.store.save_note('lab-a', team, note)
        self.manifest['id'] = 'lab-b'
        self.ingest()
        self.store.file_path('lab-a', self.version, 'src/helpers/defs.asm').write_text('changed\n')
        labs = self.store.list_labs()['labs']
        self.assertEqual({l['id'] for l in labs}, {'lab-a', 'lab-b'})
        detail = self.store.detail('lab-a')['teams'][0]
        self.assertEqual(detail['notes'], note)
        self.assertEqual(detail['versions'][0]['testEvidence'], [])
        self.assertTrue(any('current run' in error for error in detail['versions'][0]['errors']))
        self.assertTrue(detail['versions'][0]['files'])
        with self.assertRaises(ValueError):
            self.store.bundle('lab-a', self.version)

    def test_missing_or_malformed_artifact_index_is_contained_in_detail(self):
        from ece218.core import write_json
        self.attach()
        artifact = self.store.test_evidence('lab-a', self.version)[0]
        self.store.path('lab-a', artifact['path']).unlink()
        self.assertEqual(self.store.detail('lab-a')['teams'][0]['versions'][0]['testEvidence'], [])
        write_json(self.store.path('lab-a', 'run-index', self.version + '.json'), {'paths': ['../outside']})
        detail = self.store.detail('lab-a')['teams'][0]['versions'][0]
        self.assertEqual(detail['testEvidence'], [])
        self.assertTrue(detail['errors'])
