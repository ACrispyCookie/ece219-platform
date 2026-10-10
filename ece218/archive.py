"""Bounded, validated archive intake; never execute archive contents.

RAR requires a locally installed 7z/7zz reader. Inspect every member first,
then stream one exact member to Python-owned output files. 7z never receives
an output directory and is never allowed to extract the whole archive.
"""
import lzma
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import shutil
import stat
import subprocess
import time
import zipfile
import zlib

MAX_TOTAL = 128 * 1024 * 1024
MAX_MEMBER = 32 * 1024 * 1024
MAX_MEMBERS = 10000
MAX_LISTING = 16 * 1024 * 1024
MAX_DIAGNOSTIC = 65536
RAR_TIMEOUT = 300


def member(value):
    if (not isinstance(value, str) or not value or len(value) > 4096
            or '\\' in value or ':' in value or value.startswith('@')
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise ValueError('unsafe relative path')
    path = PurePosixPath(value)
    if path.is_absolute() or any(p in ('', '.', '..') for p in value.split('/')):
        raise ValueError('unsafe relative path')
    return value


def no_links(path):
    path = Path(os.path.abspath(path))
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('symlink paths are not allowed')
    return path


def detect_format(source):
    with no_links(source).open('rb') as stream:
        magic = stream.read(8)
    if magic.startswith(b'Rar!\x1a\x07'):
        return 'rar'
    if magic[:4] in (b'PK\x03\x04', b'PK\x05\x06', b'PK\x07\x08'):
        return 'zip'
    return 'unknown'


def unzip(source, target):
    source, target = no_links(source), no_links(target)
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_MEMBERS:
            raise ValueError('archive member limit exceeded')
        seen, total = {}, 0
        for entry in entries:
            name = member(entry.filename[:-1] if entry.is_dir() else entry.filename)
            if entry.orig_filename != entry.filename:
                raise ValueError('unsafe archive member name')
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError('archive contains symlink or special file')
            if kind and (kind == stat.S_IFDIR) != entry.is_dir():
                raise ValueError('archive member type mismatch')
            if entry.is_dir() and entry.file_size:
                raise ValueError('archive directory has data')
            if name in seen:
                raise ValueError('duplicate archive member')
            seen[name] = entry.is_dir()
            total += entry.file_size
            if entry.flag_bits & 1:
                raise ValueError('encrypted archive unsupported')
            if entry.file_size > MAX_MEMBER or total > MAX_TOTAL or entry.file_size > max(1, entry.compress_size) * 200:
                raise ValueError('archive expansion limit exceeded')
        _prefix_conflicts(seen)
        files = []
        for entry in entries:
            if entry.is_dir():
                continue
            out = no_links(target / entry.filename)
            out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            count = 0
            with archive.open(entry) as src, out.open('xb') as dst:
                while True:
                    try:
                        chunk = src.read(65536)
                    except (zlib.error, lzma.LZMAError, EOFError, OSError) as exc:
                        # BZIP2 reports corrupt streams as OSError; contain all
                        # supported codecs at the reader, not the batch importer.
                        raise ValueError('ZIP decompression failed: ' + str(exc)) from exc
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > entry.file_size or count > MAX_MEMBER:
                        raise ValueError('archive size mismatch')
                    dst.write(chunk)
            if count != entry.file_size:
                raise ValueError('archive size mismatch')
            out.chmod(0o600)
            files.append(entry.filename)
        return sorted(files)


def _prefix_conflicts(seen):
    for name in seen:
        for parent in PurePosixPath(name).parents:
            if str(parent) in seen and not seen[str(parent)]:
                raise ValueError('unsafe archive file/directory prefix conflict')


def _run(command, limit, deadline, sink=None):
    """Drain both pipes without unbounded communicate(), and reap on failure."""
    count, crc, output, diagnostic = 0, 0, bytearray(), bytearray()
    with subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, shell=False) as process:
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
                selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ValueError('RAR extraction timeout')
                    for key, _ in selector.select(min(remaining, 0.25)):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        if key.data == 'stderr':
                            diagnostic.extend(chunk)
                            if len(diagnostic) > MAX_DIAGNOSTIC:
                                raise ValueError('RAR tool diagnostic limit exceeded')
                        else:
                            count += len(chunk)
                            if count > limit:
                                raise ValueError('RAR output size limit exceeded')
                            if sink is None:
                                output.extend(chunk)
                            else:
                                sink.write(chunk)
                                crc = zlib.crc32(chunk, crc)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('RAR extraction timeout')
            try:
                status = process.wait(timeout=remaining)
            except subprocess.TimeoutExpired as exc:
                raise ValueError('RAR extraction timeout') from exc
            if status != 0:
                message = diagnostic.decode('utf-8', errors='replace').strip()[:2000]
                raise ValueError('RAR 7z exited with exit status ' + str(status) + (': ' + message if message else ''))
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    return bytes(output) if sink is None else (count, crc)


def _rar_entries(raw):
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError as exc:
        raise ValueError('unsafe RAR listing encoding') from exc
    records, record = [], {}
    # Do not strip values: doing so silently changes archive member names.
    for line in text.replace('\r\n', '\n').split('\n') + ['']:
        if not line:
            if record:
                records.append(record)
                record = {}
                if len(records) > MAX_MEMBERS:
                    raise ValueError('RAR archive member limit exceeded')
            continue
        if ' = ' not in line:
            raise ValueError('unsafe RAR listing: malformed metadata')
        key, value = line.split(' = ', 1)
        if key in record or not key or any(ord(c) < 32 for c in key):
            raise ValueError('unsafe RAR listing: duplicate/invalid metadata')
        record[key] = value
    entries, seen, total = [], {}, 0
    for record in records:
        name = member(record.get('Path'))
        if record.get('Folder') not in ('+', '-'):
            raise ValueError('unsafe RAR listing: missing/invalid member type')
        folder = record['Folder'] == '+'
        size = record.get('Size', '')
        if not re.fullmatch(r'[0-9]{1,20}', size):
            raise ValueError('unsafe RAR listing: invalid size')
        size = int(size)
        if record.get('Encrypted') != '-':
            raise ValueError('RAR encrypted archive unsupported')
        for key, value in record.items():
            lower = key.lower()
            if ('link' in lower or 'reparse' in lower) and value not in ('', '-'):
                raise ValueError('RAR contains link or reparse member')
        for key in ('Alternate Stream', 'Split Before', 'Split After'):
            if record.get(key, '-') != '-':
                raise ValueError('RAR alternate stream or split member unsupported')
        attrs = record.get('Attributes', '')
        # Known DOS attributes, or a Unix regular-file/directory mode. Reject
        # unknown metadata rather than guessing whether a special node is safe.
        unix = re.fullmatch(r'(?:[DASHR_.]* )?([-d])[-rwxstST]{9}', attrs)
        dos = re.fullmatch(r'[DASHR_.]+', attrs)
        if not dos and not unix:
            raise ValueError('RAR contains special file or unsupported attributes')
        if (unix and (unix.group(1) == 'd') != folder) or (dos and ('D' in attrs) != folder):
            raise ValueError('unsafe RAR listing: conflicting member type')
        if folder and size:
            raise ValueError('unsafe RAR listing: directory has data')
        if name in seen:
            raise ValueError('duplicate RAR archive member')
        seen[name] = folder
        total += size
        if size > MAX_MEMBER or total > MAX_TOTAL:
            raise ValueError('RAR archive expansion limit exceeded')
        crc = record.get('CRC', '')
        if crc and not re.fullmatch(r'[0-9A-Fa-f]{8}', crc):
            raise ValueError('unsafe RAR listing: invalid CRC')
        entries.append((name, folder, size, crc))
    _prefix_conflicts(seen)
    return entries


def unrar(source, target):
    tool = shutil.which('7zz') or shutil.which('7z')
    if not tool:
        raise ValueError('RAR extraction requires installed 7z or 7zz')
    source, target = no_links(source), no_links(target)
    deadline = time.monotonic() + RAR_TIMEOUT
    listing = _run([tool, 'l', '-slt', '-ba', '-sccUTF-8', '-p', '--', str(source)], MAX_LISTING, deadline)
    entries = _rar_entries(listing)
    files = []
    for name, folder, size, crc in entries:
        if folder:
            continue
        out = no_links(target / name)
        out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with out.open('xb') as dst:
            count, actual_crc = _run([tool, 'x', '-so', '-spd', '-ssc', '-r-', '-bd', '-p',
                                      '--', str(source), name], size, deadline, dst)
        if count != size:
            raise ValueError('RAR archive size mismatch')
        if crc and actual_crc != int(crc, 16):
            raise ValueError('RAR archive CRC mismatch')
        out.chmod(0o600)
        files.append(name)
    return sorted(files)


def extract(source, target, archive_format=None):
    archive_format = archive_format or detect_format(source)
    if archive_format == 'zip':
        return unzip(source, target)
    if archive_format == 'rar':
        return unrar(source, target)
    raise ValueError('blocked: unknown archive format')
