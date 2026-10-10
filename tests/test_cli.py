import http.client
import json
import select
import shlex
import subprocess
import sys

from test_ingest import Fixture


class CLITests(Fixture):
    def setUp(self):
        super().setUp()
        self.archive()
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.command = [sys.executable, '-m', 'ece218', '--workspace', str(self.store.root)]

    def cli(self, *args):
        return subprocess.run([*self.command, *args], text=True, capture_output=True, timeout=5)

    def imported(self):
        result = self.cli('import', str(self.manifest_path))
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_full_import_list_prepare_review_import_and_export(self):
        detail = self.imported()
        version = detail['teams'][0]['versions'][0]['id']
        self.assertEqual(json.loads(self.cli('list').stdout)['labs'][0]['id'], 'lab-a')
        prepared = self.cli('prepare', 'lab-a', '--version', version)
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        self.assertEqual(json.loads(prepared.stdout)['prepared'], 1)
        bundle = self.store.bundle('lab-a', version)
        report = {key: bundle[key] for key in ['schemaVersion', 'labId', 'teamId', 'versionId', 'inputHash']}
        report.update(summary='Fixture draft', exercises=[{'id': 'one', 'status': 'review_needed',
                      'summary': 'Oral explanation needed', 'findings': [], 'oralQuestions': ['Explain?']}])
        report_path = self.base / 'report.json'
        report_path.write_text(json.dumps(report))
        imported = self.cli('review-import', 'lab-a', str(report_path))
        self.assertEqual(imported.returncode, 0, imported.stderr)
        exported_path = self.base / 'export.json'
        result = self.cli('report', 'lab-a', '--json', str(exported_path))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(exported_path.read_text())['counts']['reviewed'], 1)
        self.assertEqual(json.loads(result.stdout)['teams'][0]['versions'][0]['status'], 'draft')

    def test_review_run_explicit_real_external_process(self):
        self.imported()
        runner = self.base / 'runner.py'
        runner.write_text('import json,sys\nb=json.load(sys.stdin)\nr={k:b[k] for k in ["schemaVersion","labId","teamId","versionId","inputHash"]}\nr.update(summary="fixture",exercises=[dict(id=e["id"],status="review_needed",summary="ask",findings=[],oralQuestions=["Explain?"]) for e in b["exercises"]])\nprint(json.dumps(r))\n')
        result = self.cli('review-run', 'lab-a', '--command', shlex.join([sys.executable, str(runner)]), '--timeout', '2')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['reviewed'], 1)
        runner.write_text('raise SystemExit(9)\n')
        result = self.cli('review-run', 'lab-a', '--command', shlex.join([sys.executable, str(runner)]))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(json.loads(result.stdout)['errors']), 1)

    def test_historical_evidence_import_cli_keeps_drafts_pending(self):
        detail = self.imported()
        legacy = {'archive': detail['teams'][0]['versions'][0]['archive'], 'exercises': {'bs': {'total': 19}, 'substr': {'total': 25}}}
        path = self.base / 'historical.json'
        path.write_text(json.dumps({'groups': [{'versions': [legacy]}]}))
        result = self.cli('evidence-import', 'lab-a', str(path))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'imported': 1})
        result = json.loads(self.cli('report', 'lab-a').stdout)
        version = result['teams'][0]['versions'][0]
        self.assertEqual(version['evidence']['legacy'], legacy)
        self.assertEqual(version['status'], 'pending')

    def test_multilab_and_help_and_clean_error(self):
        self.imported()
        self.manifest['id'] = 'lab-b'
        self.manifest['title'] = 'Lab B'
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.assertEqual(self.cli('init', str(self.manifest_path)).returncode, 0)
        self.assertEqual(len(json.loads(self.cli('list').stdout)['labs']), 2)
        self.assertIn('--workspace', self.cli('--help').stdout)
        self.assertIn('--hostLAN', self.cli('serve', '--help').stdout)
        result = self.cli('prepare', '../escape')
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('Traceback', result.stderr)

    def test_serve_entrypoint_uses_actual_http_server(self):
        self.imported()
        proc = subprocess.Popen([*self.command, 'serve', '--host', '127.0.0.1', '--port', '0'],
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            ready, _, _ = select.select([proc.stdout], [], [], 3)
            self.assertTrue(ready, 'serve did not report startup')
            line = proc.stdout.readline()
            self.assertIn('http://127.0.0.1:', line)
            port = int(line.strip().rsplit(':', 1)[1])
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
            try:
                conn.request('GET', '/api/labs')
                reply = conn.getresponse()
                self.assertEqual(reply.status, 200)
                self.assertEqual(json.loads(reply.read())['labs'][0]['id'], 'lab-a')
            finally:
                conn.close()
        finally:
            proc.terminate()
            proc.communicate(timeout=3)
