"""CSV authority and original availability, without invented historical evidence."""
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import csv
import json
import os
import unittest
import zipfile
import build_data as mod

SCRATCH=Path(os.environ.get('TMPDIR',Path.home()/'.hermes/cache/scratch'))

class DashboardFixtureTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.root=Path(self.stack.enter_context(TemporaryDirectory(dir=SCRATCH)))
        self.here=self.root/'summary';self.here.mkdir()
        self.submissions=self.root/'Lab1/submissions';self.submissions.mkdir(parents=True)
        self.csv=self.root/'lab1_results_by_student.csv';self.cache=self.root/'.submission-cache'
        self.archive='team.zip';self.legacy='/workspace/old/Lab1/submissions/team/'
        with zipfile.ZipFile(self.submissions/self.archive,'w') as z:
            z.writestr('nested/code.asm','original source\n');z.writestr('theory.pdf',b'%PDF real fixture')
        self.row=dict(student_id='0001',group_ids='0001_0002',archives=self.archive,
                      theory_a='CORRECT',theory_b='CORRECT',theory_formats='CORRECT',theory_overall='CORRECT',theory_notes='',theory_evidence='theory.pdf')
        for ex in ['bs','substr']:
            self.row.update({ex+'_status':'TESTED',ex+'_passed':'1',ex+'_total':'1',ex+'_file':self.legacy+'nested/code.asm',ex+'_function':'function',ex+'_notes':'',ex+'_log':'/workspace/old/Lab1/submissions/grading_results/run.log',ex+'_test_01':f' 1  {"fixture":24} A=[1] X=1 0 0 PASS',ex+'_console_passed':'1',ex+'_console_total':'1',ex+'_console_tests':'1: PASS (expected=[0], got=0)',ex+'_console_notes':'historical console'})
        self.rows=[self.row,dict(self.row,student_id='0002')];self.write_csv()
        self.snapshot=self.here/'report-data.json'
        saved=dict(archive='team.zip',documents=[dict(name='theory.pdf',url='../team/theory.pdf',pages=['../grading_results/missing.png'])],files=[],exercises={ex:dict(file=dict(name='code.asm',url='../team/nested/code.asm',content='saved source'),log=None) for ex in ['bs','substr']})
        self.snapshot.write_text(json.dumps(dict(groups=[dict(id='0001_0002',versions=[saved])])))
        for key,value in dict(HERE=self.here,ROOT=self.root,SUBMISSIONS=self.submissions,EVIDENCE=self.root/'grading_results',CSV_FILE=self.csv,CACHE=self.cache,SNAPSHOT=self.snapshot).items():
            self.stack.enter_context(patch.object(mod,key,value,create=True))

    def write_csv(self):
        fields=list(dict.fromkeys(k for row in self.rows for k in row))
        with self.csv.open('w',encoding='utf-8',newline='') as f:
            writer=csv.DictWriter(f,fieldnames=fields);writer.writeheader();writer.writerows(self.rows)

    def version(self):return mod.build_data()['groups'][0]['versions'][0]

    def test_legacy_paths_recover_real_originals_in_ignored_cache(self):
        version=self.version();source=version['exercises']['bs']['file']
        self.assertTrue(source['available'],'Original archive source is currently marked missing')
        self.assertEqual(source['content'],'original source\n')
        self.assertEqual(source['provenance'],'original_archive')
        self.assertTrue(source['snapshotContentMismatch'])
        self.assertEqual(source['importedSnapshotContent'],'saved source')
        self.assertEqual(mod.local_path(self.legacy+'nested/code.asm'),self.cache/'team/members/nested/code.asm')
        self.assertTrue(version['archiveFile']['available'])
        self.assertEqual(version['archiveFile']['name'],'team.zip')
        self.assertEqual(len(version['files']),2)
        self.assertEqual(len(version['documents']),1)
        self.assertTrue(version['documents'][0]['available'])
        self.assertEqual(version['documents'][0]['pages'],[])
        self.assertFalse(version['documents'][0]['pageImagesAvailable'])
        self.assertFalse(version['exercises']['bs']['log']['available'])

    def test_original_scanned_image_is_a_document_but_resource_fork_is_not(self):
        with zipfile.ZipFile(self.submissions/self.archive,'a') as z:
            z.writestr('scan.jpg',b'original scan fixture')
            z.writestr('__MACOSX/._theory.pdf',b'resource fork')
        docs=self.version()['documents']
        self.assertEqual({d['name'] for d in docs},{'theory.pdf','scan.jpg'})

    def test_absent_source_keeps_snapshot_code_but_not_false_availability(self):
        for row in self.rows:row['bs_file']=self.legacy+'absent.asm'
        self.write_csv();v=self.version();source=v['exercises']['bs']['file']
        self.assertFalse(source['available'])
        self.assertEqual(source['content'],'saved source')
        self.assertEqual(source['provenance'],'imported_snapshot')
        self.assertEqual(source['originalAvailability'],'unavailable')
        self.assertEqual(v['exercises']['bs']['passed'],1)

    def test_csv_edits_override_imported_scores(self):
        for row in self.rows:
            row['theory_overall']='REVIEW_NEEDED';row['bs_passed']='0';row['bs_test_01']=f' 1  {"fixture":24} A=[1] X=1 0 1 FAIL'
        self.write_csv();v=self.version()
        self.assertEqual(v['theory']['overall'],'REVIEW_NEEDED')
        self.assertEqual(v['exercises']['bs']['passed'],0)
        self.assertEqual(v['exercises']['bs']['tests'][0]['got'],1)
        self.assertEqual(v['exercises']['bs']['console']['passed'],1)

    def test_explicit_individual_rows_keep_documents_and_archive_identity(self):
        for row in self.rows:
            row['individual_submission']=row['student_id'];row['bs_notes']='Individual '+row['student_id']
        self.write_csv();data=mod.build_data();versions=data['groups'][0]['versions']
        self.assertEqual(data['counts'],dict(groups=1,students=2,archives=1))
        self.assertEqual({v['studentId'] for v in versions},{'0001','0002'})
        self.assertTrue(all(v['documents'] and v['archiveFile']['available'] for v in versions))

    def test_snapshot_refresh_keeps_an_immutable_copy_of_the_imported_baseline(self):
        original=self.snapshot.read_bytes()
        data=mod.write_snapshot()
        backup=self.cache/'.baseline/report-data.original.json'
        self.assertTrue(backup.is_file(),'Snapshot regeneration must preserve the imported baseline first')
        self.assertEqual(backup.read_bytes(),original)
        self.assertEqual(data['sourceProvenance']['kind'],'current_csv')
        again=mod.write_snapshot()
        self.assertEqual(backup.read_bytes(),original)
        self.assertTrue(again['groups'][0]['versions'][0]['exercises']['bs']['file']['snapshotContentMismatch'])

    def test_refreshed_snapshot_uses_preserved_imported_baseline_for_missing_source(self):
        mod.write_snapshot()
        for row in self.rows:row['bs_file']=self.legacy+'absent.asm'
        self.write_csv()
        source=self.version()['exercises']['bs']['file']
        self.assertFalse(source['available'])
        self.assertEqual(source['content'],'saved source')
        self.assertEqual(source['provenance'],'imported_snapshot')

    def test_legacy_traversal_and_external_absolute_paths_are_rejected(self):
        for value in [self.legacy+'../../outside.asm','/etc/passwd',self.legacy+'nested\\bad.asm']:
            with self.subTest(value=value),self.assertRaises(ValueError):mod.local_path(value)

if __name__=='__main__':unittest.main()
