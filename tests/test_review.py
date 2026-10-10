import copy
import json
from pathlib import Path
import shlex
import sys
import zipfile

from test_ingest import Fixture


class ReviewTests(Fixture):
    def setUp(self):
        super().setUp()
        self.archive()
        self.ingest()
        self.version = self.store.detail('lab-a')['teams'][0]['versions'][0]['id']
        self.team = self.store.detail('lab-a')['teams'][0]['id']

    def prepared(self):
        self.assertTrue(hasattr(self.store, 'prepare'), 'bundle preparation is missing')
        self.assertEqual(self.store.prepare('lab-a'), {'prepared': 1, 'errors': []})
        return self.store.bundle('lab-a', self.version)

    def report_fixture(self, bundle):
        source = bundle['files'][0]['path']
        return {'schemaVersion': 1, 'labId': 'lab-a', 'teamId': self.team, 'versionId': self.version,
                'inputHash': bundle['inputHash'], 'summary': 'Draft observation',
                'exercises': [{'id': 'one', 'status': 'partial', 'summary': 'Answer needs explanation',
                    'findings': [{'severity': 'warning', 'message': 'Explanation missing',
                                  'citations': [{'path': source, 'line': 1, 'quote': 'addi a0'}]}],
                    'oralQuestions': ['Why add one?']}]}

    def test_bundle_hashes_originals_and_trust_boundary_and_full_text(self):
        bundle = self.prepared()
        self.assertEqual(bundle['schemaVersion'], 1)
        self.assertEqual(bundle['teamId'], self.team)
        self.assertIn('UNTRUSTED', bundle['instructions'])
        self.assertIn('draft', bundle['instructions'])
        self.assertEqual(bundle['files'][0]['content'], 'addi a0, zero, 1\nret\n')
        self.assertEqual(len(bundle['files'][0]['sha256']), 64)
        self.assertIn('content', bundle['materials'][0])
        self.assertIn('archive', bundle)
        self.assertEqual(bundle, self.store.bundle('lab-a', self.version))

    def test_docx_pdf_and_binary_extraction_are_explicit(self):
        with zipfile.ZipFile(self.src / 'text.docx', 'w') as z:
            z.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Paragraph α</w:t></w:r></w:p></w:body></w:document>')
        (self.src / 'bad.pdf').write_bytes(b'not a pdf')
        self.manifest['materials'] += [{'role': 'handout', 'path': 'text.docx'}, {'role': 'solution', 'path': 'bad.pdf'}]
        self.archive('0012_0345 - Δ.zip', {'binary.bin': b'\xff\x00'})
        self.ingest()
        self.version = self.store.detail('lab-a')['teams'][0]['versions'][-1]['id']
        self.assertTrue(hasattr(self.store, 'prepare'), 'bundle preparation is missing')
        result = self.store.prepare('lab-a')
        self.assertEqual(result['prepared'], 2)
        bundle = self.store.bundle('lab-a', self.version)
        docx = next(m for m in bundle['materials'] if m['path'].endswith('.docx'))
        pdf = next(m for m in bundle['materials'] if m['path'].endswith('.pdf'))
        self.assertEqual(docx['content'], 'Paragraph α')
        self.assertEqual(pdf['extraction']['status'], 'failed')
        self.assertTrue(pdf['extraction']['error'])
        binary = next(f for b in [self.store.bundle('lab-a', v['id']) for v in self.store.detail('lab-a')['teams'][0]['versions']] for f in b['files'] if f['path'].endswith('.bin'))
        self.assertEqual(binary['extraction']['status'], 'unsupported')

    def test_pdf_text_pages_and_scanned_empty_pages_and_pdf_citations(self):
        try:
            from pypdf import PdfWriter
            from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
        except ImportError:
            self.skipTest('optional pypdf not installed in base stdlib environment')
        writer = PdfWriter()
        page = writer.add_blank_page(width=300, height=300)
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
        stream = DecodedStreamObject()
        stream.set_data(b'BT /F1 12 Tf 30 260 Td (Answer explained here) Tj ET')
        page[NameObject('/Contents')] = writer._add_object(stream)
        with (self.src / 'handout.pdf').open('wb') as output:
            writer.write(output)
        blank = PdfWriter()
        blank.add_blank_page(width=300, height=300)
        with (self.src / 'scan.pdf').open('wb') as output:
            blank.write(output)
        self.manifest['materials'] += [{'role': 'handout', 'path': 'handout.pdf'}, {'role': 'solution', 'path': 'scan.pdf'}]
        self.ingest()
        value = self.prepared()
        pdf = next(s for s in value['materials'] if s['path'].endswith('handout.pdf'))
        scan = next(s for s in value['materials'] if s['path'].endswith('scan.pdf'))
        self.assertEqual(pdf['extraction']['status'], 'ok')
        self.assertIn('Answer explained', pdf['pages'][0])
        self.assertEqual(scan['extraction']['status'], 'failed')
        self.assertIn('OCR', scan['extraction']['error'])
        report = self.report_fixture(value)
        citation = {'path': pdf['path'], 'page': 1, 'quote': 'Answer explained'}
        report['exercises'][0]['findings'][0]['citations'] = [citation]
        self.store.review_import('lab-a', report)
        citation['page'] = 2
        with self.assertRaises(ValueError):
            self.store.review_import('lab-a', report)

    def test_empty_docx_is_explicit_extraction_failure(self):
        with zipfile.ZipFile(self.src / 'empty.docx', 'w') as archive:
            archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>')
        self.manifest['materials'].append({'role': 'handout', 'path': 'empty.docx'})
        self.ingest()
        value = self.prepared()
        source = next(m for m in value['materials'] if m['path'].endswith('.docx'))
        self.assertEqual(source['extraction']['status'], 'failed')
        self.assertIn('no extractable text', source['extraction']['error'])

    def test_tampered_bundle_content_cannot_forge_source_citations(self):
        value = self.prepared()
        from ece218.core import write_json
        value['files'][0]['content'] = 'forged student quote\n'
        write_json(self.store.path('lab-a', 'bundles', self.version + '.json'), value)
        report = self.report_fixture(value)
        report['exercises'][0]['findings'][0]['citations'][0]['quote'] = 'forged student quote'
        with self.assertRaises(ValueError):
            self.store.review_import('lab-a', report)

    def test_tampered_bundle_cannot_authorize_scores(self):
        value = self.prepared()
        from ece218.core import write_json
        value['rubric'] = {'one': {'maxScore': 10}}
        write_json(self.store.path('lab-a', 'bundles', self.version + '.json'), value)
        report = self.report_fixture(value)
        report['exercises'][0]['score'] = 5
        with self.assertRaises(ValueError):
            self.store.review_import('lab-a', report)

    def test_tampered_bundle_cannot_authorize_unknown_exercises(self):
        value = self.prepared()
        from ece218.core import write_json
        value['exercises'][0]['id'] = 'forged'
        write_json(self.store.path('lab-a', 'bundles', self.version + '.json'), value)
        report = self.report_fixture(value)
        report['exercises'][0]['id'] = 'forged'
        with self.assertRaises(ValueError):
            self.store.review_import('lab-a', report)

    def test_added_original_or_changed_material_invalidates_bundle(self):
        self.prepared()
        root = self.store.path('lab-a', 'submissions', self.version)
        (root / 'added.txt').write_text('extra source')
        with self.assertRaises(ValueError):
            self.store.bundle('lab-a', self.version)
        (root / 'added.txt').unlink()
        material = self.store.material_path('lab-a', self.store.manifest('lab-a')['materials'][0]['path'])
        material.write_text('changed rubric')
        with self.assertRaises(ValueError):
            self.store.bundle('lab-a', self.version)

    def test_notes_reject_unknown_fields_without_overwriting_existing_note(self):
        note = {'text': 'original', 'decision': 'pending'}
        self.store.save_note('lab-a', self.team, note)
        with self.assertRaises(ValueError):
            self.store.save_note('lab-a', self.team, dict(note, review={'status': 'approved'}))
        self.assertEqual(self.store.detail('lab-a')['teams'][0]['notes'], note)

    def test_citations_match_dashboard_original_file_paths(self):
        bundle = self.prepared()
        report = self.report_fixture(bundle)
        self.store.review_import('lab-a', report)
        version = self.store.detail('lab-a')['teams'][0]['versions'][0]
        citation = version['review']['exercises'][0]['findings'][0]['citations'][0]
        self.assertIn(citation['path'], [file['path'] for file in version['files']])

    def test_source_backed_review_stored_only_as_draft(self):
        report = self.report_fixture(self.prepared())
        self.store.review_import('lab-a', report)
        version = self.store.detail('lab-a')['teams'][0]['versions'][0]
        self.assertEqual(version['status'], 'draft')
        self.assertEqual(version['review']['status'], 'draft')
        self.assertIsNone(self.store.detail('lab-a')['teams'][0]['notes'])
        self.assertEqual(self.store.report('lab-a')['counts']['reviewed'], 1)

    def test_rejects_identity_stale_missing_unknown_exercises_and_wrong_types(self):
        report = self.report_fixture(self.prepared())
        mutations = [lambda r: r.update(labId='other'), lambda r: r.update(teamId='t-other'),
                     lambda r: r.update(versionId='v-other'), lambda r: r.update(inputHash='0' * 64),
                     lambda r: r.update(schemaVersion=True), lambda r: r.update(summary=[]),
                     lambda r: r.update(exercises=[]), lambda r: r['exercises'][0].update(id='unknown'),
                     lambda r: r['exercises'][0].update(status='approved'),
                     lambda r: r['exercises'][0].update(oralQuestions=[1]),
                     lambda r: r['exercises'][0].update(score=1),
                     lambda r: r['exercises'][0]['findings'][0].update(severity='banana'),
                     lambda r: r['exercises'][0]['findings'][0].update(citations=[])]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                changed = copy.deepcopy(report)
                mutate(changed)
                with self.assertRaises(ValueError):
                    self.store.review_import('lab-a', changed)
        self.assertIsNone(self.store.detail('lab-a')['teams'][0]['versions'][0]['review'])

    def test_citation_validation_paths_line_page_quote(self):
        report = self.report_fixture(self.prepared())
        for changes in [{'path': '/etc/passwd'}, {'line': 900}, {'line': 0}, {'line': True},
                        {'page': 1}, {'quote': 'not in source'}, {'quote': 2}]:
            changed = copy.deepcopy(report)
            changed['exercises'][0]['findings'][0]['citations'][0].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.store.review_import('lab-a', changed)

    def test_stale_hash_material_source_or_added_file_invalidates_bundle_and_review(self):
        report = self.report_fixture(self.prepared())
        self.store.review_import('lab-a', report)
        source = self.store.file_path('lab-a', self.version, 'α/answer.asm')
        source.write_text('changed\n')
        with self.assertRaises(ValueError):
            self.store.review_import('lab-a', report)
        with self.assertRaises(ValueError):
            self.store.bundle('lab-a', self.version)
        version = self.store.detail('lab-a')['teams'][0]['versions'][0]
        self.assertEqual(version['status'], 'pending')
        self.assertIsNone(version['review'])
        self.assertTrue(version['errors'])

    def test_blocked_and_unresolved_not_prepared_without_mapping(self):
        self.archive('lab1 - Unknown.zip')
        self.archive('0012_0345-bad.zip', {'../outside': 'bad'})
        self.ingest()
        self.assertTrue(hasattr(self.store, 'prepare'), 'bundle preparation is missing')
        result = self.store.prepare('lab-a')
        self.assertEqual(result['prepared'], 1)
        self.assertEqual(len(result['errors']), 2)
        with self.assertRaises(FileNotFoundError):
            self.store.prepare('lab-a', version='v-nope')

    def test_explicit_rubric_allows_bounded_score_only(self):
        self.manifest['rubric'] = {'one': {'maxScore': 3}}
        self.ingest()
        report = self.report_fixture(self.prepared())
        report['exercises'][0]['score'] = 2
        self.store.review_import('lab-a', report)
        for value in [True, -1, 4, float('nan'), '2']:
            report['exercises'][0]['score'] = value
            with self.assertRaises(ValueError):
                self.store.review_import('lab-a', report)

    def test_notes_persist_separately_and_validate_team_and_content(self):
        self.assertTrue(hasattr(self.store, 'save_note'), 'human notes missing')
        note = {'text': 'Ask about register choice', 'decision': 'approved', 'grade': 'B+'}
        self.store.save_note('lab-a', self.team, note)
        from ece218.core import Store
        detail = Store(self.store.root).detail('lab-a')
        self.assertEqual(detail['teams'][0]['notes'], note)
        self.assertIsNone(detail['teams'][0]['versions'][0]['review'])
        for changed in [{'text': 7, 'decision': 'approved'}, {'text': '', 'decision': 'draft'},
                        {'text': '', 'decision': 'pending', 'grade': 3}]:
            with self.assertRaises(ValueError):
                self.store.save_note('lab-a', self.team, changed)
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.store.save_note('lab-a', 't-nope', note)

    def test_runner_executes_real_fixture_without_shell_and_records_failure(self):
        self.prepared()
        self.assertTrue(hasattr(self.store, 'review_run'), 'review runner missing')
        script = self.base / 'review fixture.py'
        script.write_text('import json,sys\nb=json.load(sys.stdin)\nr=' + repr(self.report_fixture(self.store.bundle('lab-a', self.version))) + '\nassert b["inputHash"]==r["inputHash"]\nprint(json.dumps(r))\nprint("fixture diagnostic",file=sys.stderr)\n')
        command = shlex.join([sys.executable, str(script)])
        self.assertEqual(self.store.review_run('lab-a', command, version=self.version)['reviewed'], 1)
        evidence = self.store.detail('lab-a')['teams'][0]['versions'][0]['evidence']
        self.assertEqual(evidence['status'], 'succeeded')
        self.assertIn('fixture diagnostic', evidence['stderr'])
        script.write_text('import sys\nprint("fixture failed",file=sys.stderr)\nsys.exit(7)\n')
        result = self.store.review_run('lab-a', command, version=self.version)
        self.assertEqual(len(result['errors']), 1)
        evidence = self.store.detail('lab-a')['teams'][0]['versions'][0]['evidence']
        self.assertEqual(evidence['returncode'], 7)
        self.assertEqual(evidence['status'], 'failed')
        self.assertIn('fixture failed', evidence['stderr'])

    def test_runner_timeout_and_invalid_output_are_real_failures(self):
        self.prepared()
        self.assertTrue(hasattr(self.store, 'review_run'), 'review runner missing')
        script = self.base / 'timeout.py'
        script.write_text('import time\ntime.sleep(5)\n')
        result = self.store.review_run('lab-a', shlex.join([sys.executable, str(script)]), timeout=0.05)
        self.assertEqual(len(result['errors']), 1)
        self.assertEqual(self.store.detail('lab-a')['teams'][0]['versions'][0]['evidence']['status'], 'timeout')
        script.write_text('print("not a report")\n')
        result = self.store.review_run('lab-a', shlex.join([sys.executable, str(script)]))
        self.assertEqual(len(result['errors']), 1)
        self.assertEqual(self.store.detail('lab-a')['teams'][0]['versions'][0]['evidence']['status'], 'failed')
