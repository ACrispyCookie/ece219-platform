from pathlib import Path
import importlib.util,json,threading,unittest,urllib.request,urllib.error

HERE=Path(__file__).resolve().parent

class ReadOnlyServerTests(unittest.TestCase):
    def test_api_reloads_fixture_csv_and_serves_offline_snapshot(self):
        import start_server as mod
        from test_data import DashboardFixtureTests
        from unittest.mock import patch
        fixture=DashboardFixtureTests();fixture.setUp();self.addCleanup(fixture.doCleanups)
        (fixture.here/'data.js').write_text('window.LAB1_DATA = {};')
        with patch.object(mod,'HERE',fixture.here),patch.object(mod,'ROOT',fixture.root):
            server=mod.create_server('127.0.0.1',0)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            base=f'http://127.0.0.1:{server.server_port}{mod.BASE}'
            try:
                one=json.load(urllib.request.urlopen(base+'/api/data'))
                two=json.load(urllib.request.urlopen(base+'/api/data'))
                self.assertEqual(one['counts'],dict(groups=1,students=2,archives=1))
                self.assertNotEqual(one['generatedAt'],two['generatedAt'],'API must rebuild, not return a frozen snapshot')
                with urllib.request.urlopen(base+'/data.js') as response:
                    self.assertIn(b'window.LAB1_DATA',response.read())
                with self.assertRaises(urllib.error.HTTPError) as blocked:
                    urllib.request.urlopen(urllib.request.Request(base+'/api/data',data=b'{}',method='POST'))
                self.assertEqual(blocked.exception.code,501)
            finally:server.shutdown();server.server_close();thread.join()

    def test_original_and_evidence_downloads_are_inert_for_get_and_head(self):
        import start_server as mod
        from test_data import DashboardFixtureTests
        from unittest.mock import patch
        import zipfile
        fixture=DashboardFixtureTests();fixture.setUp();self.addCleanup(fixture.doCleanups)
        originals={'student.html':b'<script>/* synthetic, never executed */</script>',
                   'student.svg':b'<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>',
                   'nested/code.asm':b'original source\n','theory.pdf':b'%PDF real fixture',
                   '__MACOSX/._theory.pdf':b'synthetic archive metadata'}
        with zipfile.ZipFile(fixture.submissions/fixture.archive,'a') as archive:
            for name in ['student.html','student.svg','__MACOSX/._theory.pdf']:archive.writestr(name,originals[name])
        evidence=fixture.root/'grading_results/run.html';evidence.parent.mkdir()
        evidence.write_bytes(b'<script>/* synthetic evidence */</script>')
        for row in fixture.rows:row['bs_log']=str(evidence)
        fixture.write_csv()
        for name,body in {'index.html':'<script defer src="app.js"></script>',
                          'app.js':'window.syntheticDashboard = true;',
                          'data.js':'window.LAB1_DATA = {};'}.items():
            (fixture.here/name).write_text(body)
        with patch.object(mod,'HERE',fixture.here),patch.object(mod,'ROOT',fixture.root):
            server=mod.create_server('127.0.0.1',0)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            base=f'http://127.0.0.1:{server.server_port}'
            try:
                downloads={f'/.submission-cache/team/members/{name}':body for name,body in originals.items()}
                downloads['/grading_results/run.html']=evidence.read_bytes()
                for path,body in downloads.items():
                    for method in ['GET','HEAD']:
                        with self.subTest(path=path,method=method):
                            with urllib.request.urlopen(urllib.request.Request(base+path,method=method)) as response:
                                self.assertEqual(response.status,200)
                                self.assertEqual(response.headers['Content-Type'],'application/octet-stream')
                                self.assertEqual(response.headers['Content-Disposition'],'attachment')
                                self.assertEqual(response.headers['X-Content-Type-Options'],'nosniff')
                                csp=response.headers['Content-Security-Policy'] or ''
                                self.assertIn("default-src 'none'",csp)
                                self.assertIn("frame-ancestors 'none'",csp)
                                self.assertIn('sandbox',csp)
                                self.assertEqual(int(response.headers['Content-Length']),len(body))
                                self.assertEqual(response.read(),body if method=='GET' else b'')
                for name in ['index.html','app.js','data.js']:
                    for method in ['GET','HEAD']:
                        with self.subTest(asset=name,method=method):
                            with urllib.request.urlopen(urllib.request.Request(base+'/summary/'+name,method=method)) as response:
                                self.assertEqual(response.status,200)
                                self.assertNotEqual(response.headers['Content-Type'],'application/octet-stream')
                                self.assertIsNone(response.headers.get('Content-Disposition'))
                                self.assertNotIn('sandbox',response.headers.get('Content-Security-Policy',''))
                                self.assertEqual(response.read(),(fixture.here/name).read_bytes() if method=='GET' else b'')
            finally:server.shutdown();server.server_close();thread.join()

    def test_default_bind_is_loopback(self):
        import start_server as mod
        server=mod.create_server(port=0)
        try:self.assertEqual(server.server_address[0],'127.0.0.1')
        finally:server.server_close()

    def test_all_get_and_head_routes_require_one_exact_local_host(self):
        import start_server as mod
        from tempfile import TemporaryDirectory
        from unittest.mock import patch
        import http.client,os
        with TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            root=Path(tmp);here=root/'summary';here.mkdir()
            (here/'index.html').write_text('dashboard')
            (root/'lab1_results_by_student.csv').write_text('fixture csv')
            with patch.object(mod,'ROOT',root),patch.object(mod,'HERE',here),patch.object(mod,'build_data',return_value={}) as builder,patch.object(mod.Handler,'log_message'):
                server=mod.create_server(port=0)
                thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
                try:
                    port=server.server_port
                    valid=[f'127.0.0.1:{port}',f'localhost:{port}']
                    invalid=[[],['attacker.invalid:9999'],[f'attacker.invalid:{port}'],
                             ['localhost'],['localhost:0'],[f'localhost:{port}.attacker.invalid'],
                             [f'localhost:{port}@attacker.invalid'],[''],[valid[0],valid[0]],
                             [valid[0],f'attacker.invalid:{port}']]
                    for path in ['/',mod.BASE,mod.BASE+'/',mod.BASE+'/index.html',mod.BASE+'/api/data','/lab1_results_by_student.csv']:
                        for method in ['GET','HEAD']:
                            for hosts in [[v] for v in valid]+invalid:
                                with self.subTest(path=path,method=method,hosts=hosts):
                                    builder.reset_mock()
                                    conn=http.client.HTTPConnection('127.0.0.1',port,timeout=3)
                                    try:
                                        conn.putrequest(method,path,skip_host=True)
                                        for host in hosts:conn.putheader('Host',host)
                                        conn.endheaders();response=conn.getresponse();body=response.read()
                                        if hosts in [[v] for v in valid]:
                                            self.assertEqual(response.status,(302 if method=='GET' else 403) if path in ['/',mod.BASE] else 200)
                                        else:
                                            self.assertEqual(response.status,403)
                                            builder.assert_not_called()
                                        if method=='HEAD':self.assertEqual(body,b'')
                                    finally:conn.close()
                finally:server.shutdown();server.server_close();thread.join()

    def test_nonlocal_bind_requires_explicit_valid_advertised_host(self):
        import start_server as mod
        for host_lan in [None,'','0.0.0.0:3457','host/path','user@host','host\nname']:
            with self.subTest(host_lan=host_lan),self.assertRaises(ValueError):
                server=mod.create_server('0.0.0.0',0,host_lan=host_lan) if host_lan is not None else mod.create_server('0.0.0.0',0)
                server.server_close()

    def test_explicit_lan_binding_accepts_only_advertised_host_and_actual_port(self):
        import start_server as mod
        from unittest.mock import patch
        import http.client
        with patch.object(mod,'build_data',return_value={'synthetic':True}),patch.object(mod.Handler,'log_message'):
            server=mod.create_server('0.0.0.0',0,host_lan='192.0.2.10')
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                for method in ['GET','HEAD']:
                    for host,expected in [(f'192.0.2.10:{server.server_port}',200),
                                          ('192.0.2.10:0',403),(f'127.0.0.1:{server.server_port}',403),
                                          (f'localhost:{server.server_port}',403),(f'attacker.invalid:{server.server_port}',403)]:
                        with self.subTest(method=method,host=host):
                            conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
                            try:
                                conn.request(method,mod.BASE+'/api/data',headers={'Host':host})
                                response=conn.getresponse();body=response.read()
                                self.assertEqual(response.status,expected)
                                if method=='HEAD':self.assertEqual(body,b'')
                                elif expected==200:self.assertEqual(json.loads(body),{'synthetic':True})
                            finally:conn.close()
            finally:server.shutdown();server.server_close();thread.join()

    def test_cli_help_documents_explicit_lan_host_flag(self):
        import subprocess,sys
        result=subprocess.run([sys.executable,str(HERE/'start_server.py'),'--help'],capture_output=True,text=True,check=True)
        self.assertIn('--hostLAN',result.stdout)
        self.assertIn('advertised',result.stdout)

    def test_get_and_head_restrict_exact_assets_and_original_links(self):
        import start_server as mod
        from tempfile import TemporaryDirectory
        from unittest.mock import patch
        import os
        with TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            root=Path(tmp);here=root/'summary';here.mkdir()
            (here/'index.html').write_text('dashboard')
            (here/'build_data.py').write_text('private source')
            (root/'.env').write_text('private config')
            (root/'.git').mkdir();(root/'.git/config').write_text('private git config')
            (root/'workspace').mkdir();(root/'workspace/private.txt').write_text('private workspace')
            (root/'lab1_results_by_student.csv').write_text('fixture csv')
            members=root/'.submission-cache/team/members';members.mkdir(parents=True)
            (members/'source.asm').write_text('original code')
            (members/'unlisted.asm').write_text('not listed')
            (here/'app.js').symlink_to(root/'.env')
            archive=root/'Lab1/submissions/team.zip';archive.parent.mkdir(parents=True);archive.write_bytes(b'original archive fixture')
            fixture=dict(groups=[dict(versions=[dict(archiveFile=dict(url='../Lab1/submissions/team.zip',available=True),files=[dict(url='../.submission-cache/team/members/source.asm',available=True)],documents=[],exercises={})])])
            with patch.object(mod,'ROOT',root),patch.object(mod,'HERE',here),patch.object(mod,'build_data',return_value=fixture):
                server=mod.create_server('127.0.0.1',0);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
                base=f'http://127.0.0.1:{server.server_port}'
                try:
                    for path in ['/summary/index.html','/lab1_results_by_student.csv','/.submission-cache/team/members/source.asm','/Lab1/submissions/team.zip']:
                        for method in ['GET','HEAD']:
                            with urllib.request.urlopen(urllib.request.Request(base+path,method=method)) as response:self.assertEqual(response.status,200)
                    for path in ['/.env','/.git/config','/workspace/private.txt','/summary/build_data.py','/summary/app.js','/.submission-cache/team/members/unlisted.asm','/summary/%2e%2e/.env']:
                        for method in ['GET','HEAD']:
                            with self.subTest(path=path,method=method):
                                with self.assertRaises(urllib.error.HTTPError) as blocked:
                                    urllib.request.urlopen(urllib.request.Request(base+path,method=method))
                                self.assertEqual(blocked.exception.code,403)
                finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
