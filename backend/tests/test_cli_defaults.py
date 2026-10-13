"""Keep direct CLI and Makefile production defaults aligned."""
from pathlib import Path
import subprocess
import sys

import uvicorn
from lab_catalog import __main__


def test_direct_cli_defaults_to_catalog_port(monkeypatch, tmp_path):
    launches = []
    monkeypatch.setattr(sys, 'argv', ['lab_catalog', 'serve', '--data-dir', str(tmp_path / 'catalog')])
    monkeypatch.setattr(uvicorn, 'run', lambda app, **kwargs: launches.append(kwargs))
    __main__.main()
    assert launches[0]['port'] == 3457
    assert launches[0]['host'] == '127.0.0.1'
    assert launches[0]['proxy_headers'] is False


def test_make_serve_defaults_to_catalog_port():
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(['make', '-n', 'serve'], cwd=root, capture_output=True, text=True, check=True)
    assert '--port 3457' in result.stdout
    assert '--allowed-host 127.0.0.1:3457' in result.stdout
