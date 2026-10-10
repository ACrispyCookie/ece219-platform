"""Import immutable current run artifacts, linked to exact private source bytes.

Hash linkage is provenance, not proof that a caller's report is truthful. Only
import output collected by a trusted runner; numerical course grades stay separate.
"""
import hashlib
from pathlib import Path
import re
from urllib.parse import quote

from . import core as c


def validate_includes(store, lab, version, source, identity):
    """Reconstruct literal include closure without running assembly or graders."""
    parent = Path(source).parent
    closure, visiting = {}, set()
    total = 0

    def visit(name):
        nonlocal total
        c.member(name)
        if name in visiting:
            raise ValueError('include cycle')
        if name in closure:
            return
        if len(closure) + len(visiting) >= 100:
            raise ValueError('include file limit exceeded')
        path = store.file_path(lab, version, (parent / name).as_posix())
        if path.stat().st_size > 8 * 1024 * 1024:
            raise ValueError('include byte limit exceeded')
        data = path.read_bytes()
        total += len(data)
        if total > 8 * 1024 * 1024:
            raise ValueError('include byte limit exceeded')
        visiting.add(name)
        for line in data.decode('utf-8').splitlines():
            # Preserve comment markers inside quoted strings, as the runner does.
            line = re.sub(r'''("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|#.*''',
                          lambda match: match.group(1) or '', line)
            line = re.sub(r'^(?:\s*[A-Za-z_.$][\w.$]*\s*:)*\s*', '', line)
            if re.match(r'\.include\b', line, re.I):
                match = re.fullmatch(r'\.include\s+"([^"\\\r\n]+)"\s*', line, re.I)
                if not match:
                    raise ValueError('unsupported include syntax')
                child = c.member(match.group(1))
                visit((Path(name).parent / child).as_posix())
        visiting.remove(name)
        closure[name] = {'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}

    visit(Path(source).name)
    reported = identity.get('includes')
    if reported is None:
        if len(closure) > 1:
            raise ValueError('run include closure missing')
        return
    if not isinstance(reported, list) or len(reported) > 100:
        raise ValueError('invalid run include closure')
    seen = set()
    for entry in reported:
        if not isinstance(entry, dict):
            raise ValueError('invalid run include record')
        name = c.member(entry.get('path'))
        if name in seen or name not in closure:
            raise ValueError('duplicate or unexpected run include')
        seen.add(name)
        if type(entry.get('bytes')) is not int or entry != closure[name]:
            raise ValueError('stale run: include hash/size mismatch')
    if seen != set(closure):
        raise ValueError('run include closure incomplete')


def run_import(store, lab, version, source, result):
    with c.LOCK:
        record = store.version(lab, version)
        original = store.file_path(lab, version, source)
        if not isinstance(result, dict) or result.get('schema_version') != 1 or result.get('mode') != 'function':
            raise ValueError('a structured callable run artifact is required')
        if result.get('exercise') not in {e['id'] for e in store.manifest(lab)['exercises']}:
            raise ValueError('unknown run exercise')
        identity = result.get('source')
        if not isinstance(identity, dict) or identity.get('sha256') != c.sha(original):
            raise ValueError('run source hash mismatch')
        if not isinstance(identity.get('path'), str) or c.no_links(identity['path']) != original:
            raise ValueError('run source path mismatch')
        validate_includes(store, lab, version, source, identity)
        tests = result.get('tests')
        if not isinstance(tests, list):
            raise ValueError('run tests must be a list')
        statuses = [test.get('status') if isinstance(test, dict) else None for test in tests]
        if any(status not in {'pass', 'fail', 'error'} for status in statuses):
            raise ValueError('invalid test outcome')
        if result.get('status') == 'completed':
            if type(result.get('total')) is not int or result['total'] != len(tests):
                raise ValueError('run test count mismatch')
            if type(result.get('passed')) is not int or result['passed'] != statuses.count('pass'):
                raise ValueError('run passed count mismatch')
        elif result.get('status') in {'adapter_error', 'configuration_error'}:
            if result.get('passed') is not None:
                raise ValueError('an incomplete run is not an algorithm score')
        else:
            raise ValueError('unsupported run status')
        value = {'sourcePath': 'submissions/' + version + '/' + source,
                 'sourceHash': identity['sha256'], 'result': result,
                 'provenance': 'operator-imported current callable run; not a final grade'}
        key = c.digest(value)
        path = 'runs/' + version + '/' + key + '.json'
        existing = store.path(lab, path)
        if not existing.exists():
            c.write_json(existing, value)
        index = store.optional(lab, 'run-index', version) or {'paths': []}
        if path not in index['paths']:
            index['paths'].append(path)
            c.write_json(store.path(lab, 'run-index', version + '.json'), index)
        return {'imported': 1, 'path': path}


def artifacts(store, lab, version):
    store.version(lab, version)
    index = store.optional(lab, 'run-index', version) or {'paths': []}
    values = []
    for path in index['paths']:
        c.member(path)
        if not path.startswith('runs/' + version + '/'):
            raise ValueError('run index path mismatch')
        value = c.read_json(store.path(lab, path))
        source_prefix = 'submissions/' + version + '/'
        if not value['sourcePath'].startswith(source_prefix):
            raise ValueError('run artifact source mismatch')
        source = value['sourcePath'][len(source_prefix):]
        if c.sha(store.file_path(lab, version, source)) != value['sourceHash']:
            raise ValueError('stale run: original source bytes changed')
        validate_includes(store, lab, version, source, value['result']['source'])
        if Path(path).stem != c.digest(value):
            raise ValueError('run artifact content changed')
        values.append(dict(value, path=path, sha256=c.sha(store.path(lab, path)),
                           url='/api/labs/' + quote(lab) + '/runs/' + version + '/' + Path(path).name))
    return values


def artifact_path(store, lab, version, filename):
    c.member(filename)
    if '/' in filename:
        raise ValueError('run file must be a basename')
    path = 'runs/' + version + '/' + filename
    if path not in {value['path'] for value in artifacts(store, lab, version)}:
        raise FileNotFoundError('run artifact not in inventory')
    return store.path(lab, path)
