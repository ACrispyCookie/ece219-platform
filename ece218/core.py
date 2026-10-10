"""Private, version-preserving lab inventory. No student or grader execution."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil

import tempfile
import threading
from urllib.parse import quote
import zipfile

from .archive import (MAX_TOTAL, MAX_MEMBER, MAX_MEMBERS, detect_format,
                      extract, member, no_links, unzip)

ROLES = {'handout', 'guidelines', 'grader', 'testcases', 'solution'}

LOCK = threading.RLock()


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', value):
        raise ValueError('invalid opaque identifier')
    return value



def input_path(base, value):
    # Explicit operator-selected inputs may be ../ relative to a config directory;
    # unlike archive members, they are not interpreted as output paths.
    if not isinstance(value, str) or not value or Path(value).is_absolute() or any(p in value for p in ('\\', '\x00', ':')):
        raise ValueError('manifest input must be a relative path')
    raw = base / value
    if any(p.is_symlink() for p in (raw, *raw.parents)):
        raise ValueError('symlink inputs are not allowed')
    return no_links(raw)


def sha(path):
    digest = hashlib.sha256()
    with no_links(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def read_json(path):
    with no_links(path).open(encoding='utf-8') as stream:
        return json.load(stream)


def write_json(path, value):
    path = no_links(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.write-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write('\n')
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def private_copy(source, target):
    source, target = no_links(source), no_links(target)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copyfile(source, target)
    target.chmod(0o600)



def validate_manifest(data, base):
    if not isinstance(data, dict):
        raise ValueError('manifest must be an object')
    identifier(data.get('id'))
    if not isinstance(data.get('title'), str) or not data['title'].strip():
        raise ValueError('manifest title required')
    exercises = data.get('exercises')
    if not isinstance(exercises, list) or not exercises:
        raise ValueError('nonempty exercises required')
    ids = []
    for exercise in exercises:
        if not isinstance(exercise, dict) or not isinstance(exercise.get('title'), str):
            raise ValueError('exercise id and title required')
        ids.append(identifier(exercise.get('id')))
    if len(set(ids)) != len(ids):
        raise ValueError('duplicate exercise id')
    materials = data.get('materials')
    if not isinstance(materials, list):
        raise ValueError('materials must be a list')
    for item in materials:
        if not isinstance(item, dict) or item.get('role') not in ROLES:
            raise ValueError('invalid material role')
        source = input_path(base, item.get('path'))
        if not source.is_file():
            raise ValueError('material file missing: ' + item['path'])
    submissions = input_path(base, data.get('submissions'))
    if not submissions.is_dir():
        raise ValueError('submissions must be a directory')
    teams = data.get('teams', {})
    if not isinstance(teams, dict):
        raise ValueError('teams must map archive names to student ids')
    for archive, students in teams.items():
        member(archive)
        if '/' in archive or not isinstance(students, list) or not students or len(set(map(str, students))) != len(students):
            raise ValueError('invalid team mapping')
        for student in students:
            identifier(student)
    return submissions


class Store:
    def __init__(self, workspace):
        self.root = no_links(workspace)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)

    def path(self, lab, *parts):
        return no_links(self.root / 'labs' / identifier(lab) / Path(*parts))

    def manifest(self, lab):
        return read_json(self.path(lab, 'lab.json'))

    def version(self, lab, version):
        identifier(version)
        for item in self.manifest(lab)['versions']:
            if item['id'] == version:
                return item
        raise FileNotFoundError('version not found')

    def import_lab(self, manifest_path):
        with LOCK:
            manifest_path = no_links(manifest_path)
            data = read_json(manifest_path)
            submissions = validate_manifest(data, manifest_path.parent)
            lab = data['id']
            old_path = self.path(lab, 'lab.json')
            old = read_json(old_path) if old_path.exists() else {'versions': []}
            versions = {v['id']: v for v in old['versions']}
            materials = []
            for item in data['materials']:
                source = input_path(manifest_path.parent, item['path'])
                # Content-addressed material paths keep old copies private and immutable.
                rel = 'materials/' + sha(source) + '/' + member(source.name)
                private_copy(source, self.path(lab, rel))
                materials.append(dict(item, path=rel, sourcePath=item['path']))
            for archive in sorted(submissions.iterdir()):
                no_links(archive)
                if not archive.is_file():
                    continue
                archive_hash = sha(archive)
                version_id = 'v-' + archive_hash + '-' + digest(archive.name)[:12]
                students = data.get('teams', {}).get(archive.name)
                if students is None:
                    prefix = re.split(r'\s+-\s+', archive.stem, maxsplit=1)[0]
                    students = re.findall(r'(?<![A-Za-z0-9])([0-9]{4,})(?![A-Za-z0-9])', prefix)
                # Team membership is unordered; keep literal submitted/mapped IDs
                # and their original order in records, canonicalize only the key.
                membership = sorted(students) if students else []
                team = ('t-' + '-'.join(membership)) if membership and all(s.isdigit() for s in membership) else ('t-' + digest(membership)[:24] if membership else 'u-' + digest(archive.name)[:24])
                if len(team) > 128:
                    team = 't-' + digest(membership)[:24]
                if version_id in versions:
                    versions[version_id].update(teamId=team, students=students, mappingNeeded=not bool(students))
                    if versions[version_id]['status'] != 'blocked':
                        continue
                target = self.path(lab, 'archives', version_id, archive.name)
                # Retry blocked intake from the preserved original. Do not erase
                # version identity, evidence, notes, or previously valid intake.
                if version_id not in versions:
                    private_copy(archive, target)
                out = self.path(lab, 'submissions', version_id)
                if out.exists():
                    shutil.rmtree(out)
                out.mkdir(parents=True, exist_ok=True, mode=0o700)
                archive_format = versions.get(version_id, {}).get('format', 'unknown')
                record = {'id': version_id, 'archive': archive.name, 'archiveHash': archive_hash, 'format': archive_format,
                          'teamId': team, 'students': students, 'mappingNeeded': not bool(students),
                          'status': 'pending', 'files': [], 'errors': []}
                try:
                    if sha(target) != archive_hash:
                        raise ValueError('preserved archive hash mismatch')
                    archive_format = detect_format(target)
                    record['format'] = archive_format
                    record['files'] = extract(target, out, archive_format)
                except (ValueError, OSError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
                    shutil.rmtree(out)
                    record.update(status='blocked', errors=[str(exc)])
                versions[version_id] = record
            result = {'id': lab, 'title': data['title'], 'exercises': data['exercises'],
                      'materials': materials, 'versions': sorted(versions.values(), key=lambda v: (v['teamId'], v['archive'], v['id']))}
            # Numeric scores require an explicit machine-readable rubric, never inferred weights.
            if 'rubric' in data:
                result['rubric'] = data['rubric']
            write_json(old_path, result)
            return self.detail(lab)

    def file_path(self, lab, version, path):
        record = self.version(lab, version)
        member(path)
        if path not in record['files']:
            raise FileNotFoundError('file not in inventory')
        return self.path(lab, 'submissions', version, path)

    def archive_path(self, lab, version):
        record = self.version(lab, version)
        return self.path(lab, 'archives', version, member(record['archive']))

    def material_path(self, lab, path):
        member(path)
        if path not in [m['path'] for m in self.manifest(lab)['materials']]:
            raise FileNotFoundError('material not in inventory')
        return self.path(lab, path)

    def optional(self, lab, kind, key):
        path = self.path(lab, kind, identifier(key) + '.json')
        return read_json(path) if path.exists() else None

    def detail(self, lab):
        manifest = self.manifest(lab)
        teams = {}
        counts = {'teams': 0, 'versions': 0, 'pending': 0, 'reviewed': 0, 'blocked': 0}
        for record in manifest['versions']:
            team = teams.setdefault(record['teamId'], {'id': record['teamId'], 'students': record['students'],
                    'mappingNeeded': record['mappingNeeded'], 'versions': [], 'notes': self.optional(lab, 'notes', record['teamId'])})
            review = self.optional(lab, 'reviews', record['id'])
            errors = list(record['errors'])
            if review:
                try:
                    self.validate_review(lab, review)
                except (ValueError, OSError) as exc:
                    errors.append('stale/invalid review: ' + str(exc))
                    review = None
            try:
                runs = self.test_evidence(lab, record['id'])
            except (ValueError, OSError, TypeError, KeyError) as exc:
                errors.append('stale/invalid current run: ' + str(exc))
                runs = []
            status = 'blocked' if record['status'] == 'blocked' else ('draft' if review else 'pending')
            files = [{'path': 'submissions/' + record['id'] + '/' + p, 'memberPath': p, 'url': '/api/labs/' + quote(lab) + '/files/' + record['id'] + '/' + quote(p, safe='/'),
                      'kind': Path(p).suffix.lower().lstrip('.') or 'file'} for p in record['files']]
            team['versions'].append({'id': record['id'], 'archive': record['archive'], 'format': record.get('format', 'unknown'), 'status': status,
                                    'summary': review['summary'] if review else '',
                                    'exercises': review['exercises'] if review else [], 'files': files,
                                    'review': review, 'evidence': self.optional(lab, 'evidence', record['id']),
                                    'testEvidence': runs, 'errors': errors})
            counts['versions'] += 1
            counts['reviewed' if status == 'draft' else status] += 1
        counts['teams'] = len(teams)
        counts['confirmedTeams'] = sum(not team['mappingNeeded'] for team in teams.values())
        counts['unresolved'] = sum(team['mappingNeeded'] for team in teams.values())
        return {'id': manifest['id'], 'title': manifest['title'], 'exercises': manifest['exercises'], 'rubric': manifest.get('rubric'),
                'materials': [dict(m, url='/api/labs/' + lab + '/materials/' + quote(m['path'], safe='/')) for m in manifest['materials']],
                'counts': counts, 'teams': list(teams.values())}

    def prepare(self, lab, version=None):
        from .review import prepare
        return prepare(self, lab, version)

    def bundle(self, lab, version):
        from .review import bundle
        return bundle(self, lab, version)

    def validate_review(self, lab, report):
        from .review import validate
        return validate(self, lab, report)

    def review_import(self, lab, reports):
        from .review import review_import
        return review_import(self, lab, reports)

    def review_run(self, lab, command, version=None, timeout=120):
        from .review import review_run
        return review_run(self, lab, command, version, timeout)

    def save_note(self, lab, team, note):
        from .review import save_note
        return save_note(self, lab, team, note)

    def evidence_import(self, lab, data, versions=None, source='historical CSV (19/25 suite)'):
        from .review import evidence_import
        return evidence_import(self, lab, data, versions, source)

    def run_import(self, lab, version, source, result):
        from .evidence import run_import
        return run_import(self, lab, version, source, result)

    def test_evidence(self, lab, version):
        from .evidence import artifacts
        return artifacts(self, lab, version)

    def report(self, lab):
        return dict(self.detail(lab), schemaVersion=1, status='draft',
                    policy='All archive versions retained; no newest/best selection. Human decisions are separate.')

    def list_labs(self):
        parent = no_links(self.root / 'labs')
        labs = []
        if parent.exists():
            for path in sorted(parent.iterdir()):
                no_links(path)
                if path.is_dir() and (path / 'lab.json').is_file():
                    detail = self.detail(path.name)
                    labs.append({k: detail[k] for k in ('id', 'title', 'counts')})
        return {'labs': labs}
