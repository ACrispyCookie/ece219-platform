"""Read-only dashboard server. LAN needs explicit --host and --hostLAN."""
from functools import partial
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from typing import cast
from urllib.parse import urlsplit,unquote
import argparse
import json
import re

from build_data import build_data
from archive_cache import no_symlinks

HERE=Path(__file__).resolve().parent
ROOT=HERE.parent
BASE='/'+HERE.name
ASSETS={'index.html','group.html','styles.css','app.js','data.js','report-data.json'}
REFERENCES={'Lab1/guidelines.txt','Lab1/test_cases.md','Lab1/Lab1_Solutions/Lab1_RISC-V.pdf',
            'Lab1/Lab1_Solutions/Lab1_Solns_Theory.docx','Lab1/Lab1_Solutions/lab1_BinarySearch.asm',
            'Lab1/Lab1_Solutions/lab1_approximate_substring.asm'}

class Server(ThreadingHTTPServer):
    allowed_hosts: set[str]


class Handler(SimpleHTTPRequestHandler):
    def _checked_host(self):
        self._untrusted_download=False
        hosts=self.headers.get_all('Host',[])
        if len(hosts)!=1 or hosts[0] not in cast(Server,self.server).allowed_hosts:
            self.send_error(403,'Host not allowed');return False
        return True

    def _api(self,head=False):
        try:payload=json.dumps(build_data(),ensure_ascii=False).encode('utf-8')
        except (OSError,ValueError,KeyError) as exc:
            self.send_error(503,'Grading evidence unavailable: '+str(exc));return
        self.send_response(200)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(payload)))
        self.send_header('Cache-Control','no-store')
        self.end_headers()
        if not head:self.wfile.write(payload)

    def do_GET(self):
        if not self._checked_host():return
        path=urlsplit(self.path).path
        if path in ('/',BASE):
            self.send_response(302);self.send_header('Location',BASE+'/');self.end_headers();return
        if path==BASE+'/api/data':self._api();return
        super().do_GET()

    def do_HEAD(self):
        if not self._checked_host():return
        if urlsplit(self.path).path==BASE+'/api/data':self._api(head=True);return
        super().do_HEAD()

    def translate_path(self,path):
        decoded=unquote(urlsplit(path).path)
        if decoded==BASE+'/':return str(HERE/'index.html')
        return str(ROOT/decoded.lstrip('/'))

    def _allowed(self,target):
        fixed={HERE/a for a in ASSETS}|{ROOT/'lab1_results_by_student.csv'}|{ROOT/r for r in REFERENCES}
        if target in fixed:return True
        # Only exact currently available original/evidence links, not whole directories.
        if not any(target.is_relative_to(ROOT/p) for p in ('.submission-cache','Lab1/submissions','grading_results')):return False
        data=build_data();allowed=set()
        def add(file):
            if file and file.get('available'):
                p=HERE/unquote(file.get('url',''))
                if no_symlinks(p):allowed.add(p.resolve())
        for group in data.get('groups',[]):
            for version in group.get('versions',[]):
                add(version.get('archiveFile'))
                for file in version.get('files',[])+version.get('documents',[]):add(file)
                for exercise in version.get('exercises',{}).values():
                    add(exercise.get('file'));add(exercise.get('log'))
        return target in allowed

    def send_head(self):
        decoded=unquote(urlsplit(self.path).path)
        parts=decoded.lstrip('/').split('/')
        # Hidden archive members remain inert, exact-whitelisted downloads; do
        # not confuse their names with private dotfiles in the project root.
        archive_cache=bool(parts) and parts[0]=='.submission-cache'
        if '\\' in decoded or any(ord(c)<32 for c in decoded) or any(p in ('.','..') or (p.startswith('.') and not archive_cache) for p in parts):
            self.send_error(403,'Path not allowed');return None
        raw=Path(self.translate_path(self.path));target=raw.resolve()
        try:allowed=target.is_relative_to(ROOT) and no_symlinks(raw) and self._allowed(target)
        except (OSError,ValueError,KeyError):allowed=False
        if not allowed:self.send_error(403,'Only dashboard assets and exact original links are served');return None
        # A filesystem whitelist establishes availability, not document trust.
        self._untrusted_download=target not in {HERE/a for a in ASSETS}
        return super().send_head()

    def guess_type(self,path):
        if getattr(self,'_untrusted_download',False):return 'application/octet-stream'
        return super().guess_type(path)

    def end_headers(self):
        if getattr(self,'_untrusted_download',False):
            self.send_header('Content-Disposition','attachment')
            self.send_header('Content-Security-Policy',"default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'")
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        super().end_headers()

    def list_directory(self,path):
        self.send_error(403,'Directory listing disabled');return None


def create_server(host='127.0.0.1',port=3457,host_lan=None):
    if host not in {'127.0.0.1','localhost'} and not host_lan:
        raise ValueError('nonlocal binding requires explicit --hostLAN advertised IP/hostname')
    if host_lan and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}',host_lan):
        raise ValueError('hostLAN must be an explicit hostname or IPv4 address, without port')
    server=Server((host,port),partial(Handler,directory=str(ROOT)))
    names={'127.0.0.1','localhost'} if host in {'127.0.0.1','localhost'} else set()
    if host_lan:names.add(host_lan)
    server.allowed_hosts={name+':'+str(server.server_port) for name in names}
    if server.server_port==80:server.allowed_hosts.update(names)
    return server

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=3457)
    parser.add_argument('--host',default='127.0.0.1',help='Explicit interface; 0.0.0.0 exposes private student data to the LAN')
    parser.add_argument('--hostLAN',dest='host_lan',help='Explicit advertised LAN hostname/IPv4 address without port; required for nonlocal binding')
    args=parser.parse_args()
    with create_server(host=args.host,port=args.port,host_lan=args.host_lan) as server:
        print(f'Lab1 dashboard: http://{args.host_lan or args.host}:{server.server_port}{BASE}/',flush=True)
        print('Read-only API; rereads source CSV. No grading or submission edits. Ctrl+C to stop.',flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
