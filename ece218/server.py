"""Local-only HTTP API; never exposes the repository or private storage tree."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import json
import mimetypes
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

from .core import LOCK, member, no_links

BODY_LIMIT = 128 * 1024
STATIC_SUFFIXES = {'.html', '.css', '.js', '.json', '.svg', '.png', '.jpg', '.jpeg', '.ico', '.woff', '.woff2'}


class HTTPError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class Handler(BaseHTTPRequestHandler):
    server_version = 'LabReview/1'

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, fmt, *args):
        # Avoid writing private filenames, user notes, or review excerpts to logs.
        pass

    def send(self, status, value, kind='application/json; charset=utf-8', attachment=False):
        body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode() if not isinstance(value, bytes) else value
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
        if attachment:
            self.send_header('Content-Disposition', 'attachment')
        self.end_headers()
        self.wfile.write(body)

    def checked_host(self):
        hosts = self.headers.get_all('Host', [])
        if len(hosts) != 1 or hosts[0] not in self.server.allowed_hosts:
            raise HTTPError(403, 'Host not allowed')
        return hosts[0]

    def json_body(self, host):
        origins = self.headers.get_all('Origin', [])
        if origins != ['http://' + host]:
            raise HTTPError(403, 'exact same Origin required')
        if self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json':
            raise HTTPError(415, 'application/json required')
        lengths = self.headers.get_all('Content-Length', [])
        if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not re.fullmatch('[0-9]+', lengths[0]):
            raise HTTPError(400, 'single Content-Length required; chunked input unsupported')
        length = int(lengths[0])
        if length > BODY_LIMIT:
            raise HTTPError(413, 'request body too large')
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise HTTPError(400, 'incomplete request body')
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise HTTPError(400, 'JSON object required')
        return value

    def dispatch(self, mutate=False):
        try:
            host = self.checked_host()
            parsed = urlsplit(self.path)
            if parsed.scheme or parsed.netloc or parsed.fragment:
                raise HTTPError(400, 'only canonical paths supported')
            path = unquote(parsed.path, errors='strict')
            if path != '/' and (not path.startswith('/') or any(p in ('', '.', '..') for p in path[1:].split('/'))):
                raise HTTPError(400, 'unsafe request path')
            parts = path.strip('/').split('/')
            store = self.server.store
            with LOCK:
                if path == '/api/labs' and not mutate:
                    return self.send(200, store.list_labs())
                if parts[:2] == ['api', 'labs'] and len(parts) >= 3:
                    lab = parts[2]
                    if mutate:
                        value = self.json_body(host)
                        if parts[3:] == ['prepare']:
                            if value:
                                raise HTTPError(400, 'prepare body must be an empty object; no execution from web')
                            return self.send(200, store.prepare(lab))
                        if len(parts) == 5 and parts[3] == 'notes':
                            return self.send(200, store.save_note(lab, parts[4], value))
                    else:
                        if len(parts) == 3:
                            return self.send(200, store.detail(lab))
                        if parts[3:] == ['report']:
                            return self.send(200, store.report(lab))
                        if len(parts) == 5 and parts[3] == 'bundles':
                            return self.send(200, store.bundle(lab, parts[4]))
                        if len(parts) >= 6 and parts[3] == 'files':
                            file = store.file_path(lab, parts[4], '/'.join(parts[5:]))
                            return self.send_file(file, private=True)
                        if len(parts) == 6 and parts[3] == 'runs':
                            from .evidence import artifact_path
                            return self.send_file(artifact_path(store, lab, parts[4], parts[5]), private=True)
                        if len(parts) >= 5 and parts[3] == 'materials':
                            file = store.material_path(lab, '/'.join(parts[4:]))
                            return self.send_file(file, private=True)
                    raise FileNotFoundError('route not found')
                if mutate or path.startswith('/api/'):
                    raise FileNotFoundError('route not found')
                rel = 'index.html' if path == '/' else member(path[1:])
                if any(p.startswith('.') for p in Path(rel).parts) or Path(rel).suffix.lower() not in STATIC_SUFFIXES:
                    raise FileNotFoundError('asset not found')
                file = no_links(self.server.web_root / rel)
                return self.send_file(file)
        except HTTPError as exc:
            self.send(exc.status, {'error': exc.message})
        except (FileNotFoundError, IsADirectoryError):
            self.send(404, {'error': 'not found'})
        except (ValueError, TypeError, KeyError, UnicodeError):
            self.send(400, {'error': 'invalid input, stale bundle, or unsafe path'})
        except (TimeoutError, ConnectionError, BrokenPipeError):
            self.close_connection = True
        except OSError:
            self.send(500, {'error': 'storage error'})

    def send_file(self, path, private=False):
        kind = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        if private and kind not in {'application/pdf', 'text/plain'}:
            kind = 'application/octet-stream'
        self.send(200, path.read_bytes(), kind, attachment=private)

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch(mutate=True)


class Server(ThreadingHTTPServer):
    daemon_threads = True


def create_server(store, web_root=None, host='127.0.0.1', port=3458, host_lan=None):
    if host not in {'127.0.0.1', 'localhost'} and not host_lan:
        raise ValueError('nonlocal binding requires explicit --hostLAN advertised IP/hostname')
    if host_lan:
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}', host_lan):
            raise ValueError('hostLAN must be an explicit hostname or IPv4 address, without port')
    server = Server((host, port), Handler)
    server.store = store
    server.web_root = no_links(web_root if web_root is not None else Path(__file__).resolve().parent.parent / 'web')
    actual_port = server.server_address[1]
    names = {'127.0.0.1', 'localhost'} if host in {'127.0.0.1', 'localhost'} else {host_lan}
    if host_lan:
        names.add(host_lan)
    server.allowed_hosts = {name + ':' + str(actual_port) for name in names}
    if actual_port == 80:
        server.allowed_hosts.update(names)
    return server
