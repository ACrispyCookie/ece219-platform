import http.client
import importlib
import json
from pathlib import Path
import threading
from urllib.parse import quote

from test_ingest import Fixture

try:
    create_server = importlib.import_module('ece218.server').create_server
except ModuleNotFoundError:
    create_server = None


class ServerTests(Fixture):
    def setUp(self):
        super().setUp()
        self.assertIsNotNone(create_server, 'HTTP server is missing')
        self.archive()
        self.ingest()
        self.web = self.base / 'web'
        self.web.mkdir()
        (self.web / 'index.html').write_text('<h1>Test UI</h1>')
        (self.web / 'app.js').write_text('console.log("fixture");')
        (self.web / '.secret').write_text('secret')
        (self.web / 'leak.txt').symlink_to(self.src / 'rubric.txt')
        self.server = create_server(self.store, self.web, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.port = self.server.server_address[1]
        self.origin = f'http://127.0.0.1:{self.port}'
        self.version = self.store.detail('lab-a')['teams'][0]['versions'][0]['id']
        self.team = self.store.detail('lab-a')['teams'][0]['id']
        self.prefix = '/api/labs/lab-a'

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, method='GET', body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            reply = conn.getresponse()
            return reply.status, reply.read(), dict(reply.getheaders())
        finally:
            conn.close()

    def post(self, path, data, **headers):
        return self.request(path, 'POST', json.dumps(data), {'Origin': self.origin, 'Content-Type': 'application/json', **headers})

    def test_all_read_routes_and_prepare_and_notes_persist(self):
        status, body, _ = self.request('/api/labs')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['labs'][0]['counts']['versions'], 1)
        status, body, _ = self.request(self.prefix)
        self.assertEqual(json.loads(body)['teams'][0]['versions'][0]['exercises'], [])
        status, body, _ = self.request(self.prefix + '/bundles/' + self.version)
        self.assertEqual(status, 404)
        status, body, _ = self.post(self.prefix + '/prepare', {})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'prepared': 1, 'errors': []})
        status, body, _ = self.request(self.prefix + '/bundles/' + self.version)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), self.store.bundle('lab-a', self.version))
        status, body, _ = self.request(self.prefix + '/report')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['status'], 'draft')
        note = {'text': 'Human only', 'decision': 'needs_changes', 'grade': 'not graded'}
        self.assertEqual(self.post(self.prefix + '/notes/' + self.team, note)[0], 200)
        self.assertEqual(json.loads(self.request(self.prefix)[1])['teams'][0]['notes'], note)
        self.assertIsNone(self.store.detail('lab-a')['teams'][0]['versions'][0]['review'])

    def test_unicode_original_file_and_material_are_whitelisted_attachments(self):
        path = self.prefix + '/files/' + self.version + '/' + quote('α/answer.asm', safe='')
        status, body, headers = self.request(path)
        self.assertEqual(status, 200)
        self.assertEqual(body, b'addi a0, zero, 1\nret\n')
        self.assertTrue(headers['Content-Disposition'].startswith('attachment'))
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        material = self.store.detail('lab-a')['materials'][0]['url']
        self.assertEqual(self.request(material)[0], 200)
        self.assertEqual(self.request(self.prefix + '/materials/../lab.json')[0], 400)

    def test_spa_query_navigation_still_serves_index_without_file_mapping(self):
        status, body, _ = self.request('/?lab=lab-a&team=' + self.team + '&version=' + self.version)
        self.assertEqual(status, 200)
        self.assertEqual(body, b'<h1>Test UI</h1>')
        self.assertEqual(self.request('/?file=/etc/passwd')[1], b'<h1>Test UI</h1>')

    def test_current_run_links_serve_only_indexed_immutable_artifacts(self):
        from ece218.core import sha
        result = {'schema_version': 1, 'mode': 'function', 'exercise': 'one', 'function': 'entry',
                  'source': {'path': str(self.store.file_path('lab-a', self.version, 'α/answer.asm')),
                             'sha256': sha(self.store.file_path('lab-a', self.version, 'α/answer.asm'))},
                  'status': 'completed', 'total': 1, 'passed': 1,
                  'tests': [{'index': 1, 'status': 'pass', 'expected': [1], 'got': 1}]}
        self.store.run_import('lab-a', self.version, 'α/answer.asm', result)
        artifact = self.store.test_evidence('lab-a', self.version)[0]
        status, body, headers = self.request(artifact['url'])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['result'], result)
        self.assertEqual(headers['Content-Disposition'], 'attachment')
        self.assertEqual(self.request(self.prefix + '/runs/' + self.version + '/unlisted.json')[0], 404)
        self.store.path('lab-a', artifact['path']).write_text('{}')
        self.assertEqual(self.request(artifact['url'])[0], 400)

    def test_static_assets_only_not_private_root_dotfiles_or_symlink(self):
        self.assertEqual(self.request('/')[0], 200)
        self.assertEqual(self.request('/app.js')[0], 200)
        for path in ['/Lab1/guidelines.txt', '/summary/index.html', '/workspace/labs/lab-a/lab.json',
                     '/.git/config', '/.secret', '/leak.txt', '/api/labs/lab-a/lab.json', '/ece218/core.py']:
            with self.subTest(path=path):
                self.assertIn(self.request(path)[0], [400, 404])
        self.assertIn(self.request('/%2e%2e/inputs/rubric.txt')[0], [400, 404])
        source = self.store.file_path('lab-a', self.version, 'α/answer.asm')
        source.unlink()
        source.symlink_to('/etc/passwd')
        self.assertEqual(self.request(self.prefix + '/files/' + self.version + '/' + quote('α/answer.asm'))[0], 400)

    def test_dns_rebinding_and_cross_origin_or_missing_origin_mutations_rejected(self):
        self.assertEqual(self.request('/api/labs', headers={'Host': f'evil.example:{self.port}'})[0], 403)
        path = self.prefix + '/notes/' + self.team
        for origin in ['http://evil.example', 'null', self.origin + '/', 'https://127.0.0.1:' + str(self.port)]:
            self.assertEqual(self.post(path, {'text': 'evil', 'decision': 'approved'}, Origin=origin)[0], 403)
        self.assertEqual(self.request(path, 'POST', '{}', {'Content-Type': 'application/json'})[0], 403)
        self.assertIsNone(self.store.detail('lab-a')['teams'][0]['notes'])

    def test_body_limits_content_type_invalid_json_and_nonexistent_targets(self):
        path = self.prefix + '/notes/' + self.team
        self.assertEqual(self.post(path, {'text': 'x' * 150000, 'decision': 'pending'})[0], 413)
        self.assertEqual(self.request(path, 'POST', '{}', {'Origin': self.origin, 'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request(path, 'POST', 'not json', {'Origin': self.origin, 'Content-Type': 'application/json'})[0], 400)
        self.assertEqual(self.post(path, {'text': 1, 'decision': 'pending'})[0], 400)
        self.assertEqual(self.post(self.prefix + '/notes/t-nope', {'text': '', 'decision': 'pending'})[0], 404)
        self.assertEqual(self.request('/api/labs/nope')[0], 404)
        self.assertEqual(self.post(self.prefix + '/prepare', {'command': 'execute student'})[0], 400)

    def test_nonlocal_binding_requires_explicit_host_lan(self):
        with self.assertRaises(ValueError):
            create_server(self.store, self.web, host='0.0.0.0', port=0)
        other = create_server(self.store, self.web, host='0.0.0.0', port=0, host_lan='192.0.2.5')
        other.server_close()
