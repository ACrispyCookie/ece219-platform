"""Only explicitly trusted proxies may supply the browser HTTPS scheme."""
from http.cookies import SimpleCookie
from pathlib import Path
import os
import socket
import subprocess
import sys
import time

import httpx
import pytest
import uvicorn
from lab_catalog import __main__


def test_cli_enables_only_explicit_proxy_ips(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(sys, 'argv', ['lab_catalog', 'serve', '--data-dir', str(tmp_path / 'catalog'), '--trusted-proxy', '192.168.1.2'])
    monkeypatch.setattr(uvicorn, 'run', lambda app, **kwargs: calls.append(kwargs))
    __main__.main()
    assert calls[0]['proxy_headers'] is True
    assert calls[0]['forwarded_allow_ips'] == ['192.168.1.2']


@pytest.mark.parametrize('value', ['*', '0.0.0.0/0', 'network0.home.arpa', '0.0.0.0', '::'])
def test_cli_rejects_broad_or_nonliteral_proxy_trust(monkeypatch, tmp_path, value):
    monkeypatch.setattr(sys, 'argv', ['lab_catalog', 'serve', '--data-dir', str(tmp_path / 'catalog'), '--trusted-proxy', value])
    with pytest.raises(SystemExit) as exc:
        __main__.main()
    assert exc.value.code == 2
    assert not (tmp_path / 'catalog').exists()


@pytest.mark.parametrize('trusted_ip,forwarded', [('127.0.0.1', True), ('127.0.0.2', False)])
def test_real_cli_proxy_origin_cookies_and_host_guards(tmp_path, trusted_ip, forwarded):
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    root = tmp_path / 'catalog'
    command = [sys.executable, '-m', 'lab_catalog', 'serve', '--data-dir', str(root), '--host', '127.0.0.1', '--port', str(port), '--allowed-host', 'ece219.njason.dev', '--allowed-host', 'ece219.home.arpa', '--trusted-proxy', trusted_ip]
    with (tmp_path / 'server.log').open('wb') as log:
        process = subprocess.Popen(command, env=dict(os.environ, PYTHONPATH=str(Path(__file__).parents[1])), stdout=log, stderr=log)
        try:
            with httpx.Client(base_url=f'http://127.0.0.1:{port}', timeout=5, headers={'Host': 'ece219.njason.dev', 'Connection': 'close'}) as client:
                for _ in range(100):
                    assert process.poll() is None, 'CLI exited before becoming ready'
                    try:
                        if client.get('/health').status_code == 200: break
                    except httpx.TransportError:
                        pass
                    time.sleep(.05)
                else: pytest.fail('CLI did not become ready')
                token = (root / 'operator-token').read_text().strip()
                https_headers = {'Origin': 'https://ece219.njason.dev', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'attacker.invalid'}
                response = client.post('/api/v1/session', json={'token': token}, headers=https_headers)
                if not forwarded:
                    assert response.status_code == 403
                    response = client.post('/api/v1/session', json={'token': token}, headers={'Origin': 'http://ece219.njason.dev', 'X-Forwarded-Proto': 'https'})
                    assert response.status_code == 200
                    assert 'secure' not in response.headers['set-cookie'].lower()
                else:
                    assert response.status_code == 200
                    cookie = SimpleCookie(response.headers['set-cookie'])
                    value = cookie['lab_catalog_session']
                    assert value['secure'] and value['httponly'] and value['samesite'].lower() == 'strict'
                    headers = {**https_headers, 'Cookie': f'{value.key}={value.value}'}
                    assert client.get('/api/v1/labs', headers=headers).status_code == 200
                    assert client.delete('/api/v1/session', headers=headers).status_code == 204
                assert client.get('/api/v1/labs', headers={'Authorization': 'Bearer ' + token, 'Origin': 'https://attacker.invalid', 'X-Forwarded-Proto': 'https'}).status_code == 403
                assert client.get('/health', headers={'Host': 'attacker.invalid', 'X-Forwarded-Host': 'ece219.njason.dev', 'X-Forwarded-Proto': 'https'}).status_code == 400
                client.cookies.clear()
                assert client.get('/api/v1/labs', headers={'Host': 'ece219.home.arpa'}).status_code == 401
        finally:
            process.terminate()
            process.wait(timeout=10)
