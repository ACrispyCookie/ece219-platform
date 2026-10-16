"""Built PDF workers are public trusted assets; uploaded modules stay inert."""
import pytest
from fastapi.testclient import TestClient
from lab_catalog.api import create_app

@pytest.mark.parametrize('method',['GET','HEAD'])
def test_built_module_worker_is_served_as_javascript(tmp_path,method):
    web=tmp_path/'web';(web/'assets').mkdir(parents=True)
    (web/'index.html').write_text('<div id="root"></div>')
    worker=b'export const syntheticWorker = true;'
    (web/'assets/pdf.worker.min-test.mjs').write_bytes(worker)
    with TestClient(create_app(tmp_path/'data',['testserver'],web)) as c:
        r=c.request(method,'/assets/pdf.worker.min-test.mjs')
        assert r.status_code==200
        assert r.headers['content-type'].split(';')[0] in ('text/javascript','application/javascript')
        assert r.headers['x-content-type-options']=='nosniff'
        assert 'content-security-policy' not in r.headers
        if method=='GET':assert r.content==worker
        assert c.get('/assets/missing.mjs').status_code==404


def test_uploaded_module_is_not_a_public_worker(tmp_path):
    web=tmp_path/'web';web.mkdir();(web/'index.html').write_text('<div id="root"></div>')
    app=create_app(tmp_path/'data',['testserver'],web)
    with TestClient(app) as c:
        token=(tmp_path/'data/operator-token').read_text().strip()
        c.headers['Authorization']='Bearer '+token
        lab=c.post('/api/v1/labs',json={'title':'Synthetic'}).json()
        source=b'globalThis.untrustedStudentModule = true;'
        f=c.post('/api/v1/labs/'+lab['id']+'/files',files={'file':('student.mjs',source,'text/javascript')}).json()
        r=c.get('/api/v1/files/'+f['id']+'/download')
        assert r.status_code==200 and r.content==source
        assert r.headers['content-type']=='application/octet-stream'
        assert r.headers['content-disposition'].startswith('attachment;')
        assert r.headers['content-security-policy']=="sandbox; default-src 'none'"
        assert r.headers['x-content-type-options']=='nosniff'
        assert c.get('/assets/student.mjs').status_code==404
        c.headers.clear()
        assert c.get('/api/v1/files/'+f['id']+'/download').status_code==401


def test_symlink_module_worker_is_not_published(tmp_path):
    web=tmp_path/'web';web.mkdir();(web/'index.html').write_text('<div id="root"></div>')
    secret=tmp_path/'not-public.mjs';secret.write_text('not a built asset')
    (web/'secret.mjs').symlink_to(secret)
    with TestClient(create_app(tmp_path/'data',['testserver'],web)) as c:
        assert c.get('/secret.mjs').status_code==404
