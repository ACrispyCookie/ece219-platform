"""Private immutable blobs and read-only bounded ZIP inspection; no extraction."""
import base64
import hashlib
import os
from pathlib import PurePosixPath
import re
import stat
import tempfile
import zipfile
import zlib

from .database import reject_symlinks

UPLOAD_LIMIT = 64 * 1024 * 1024
BODY_LIMIT = UPLOAD_LIMIT + 1024 * 1024
JSON_LIMIT = 1024 * 1024
MEMBER_LIMIT = 8 * 1024 * 1024
ARCHIVE_TOTAL_LIMIT = 64 * 1024 * 1024
MEMBER_COUNT_LIMIT = 1000
RATIO_LIMIT = 200
TEXT_LIMIT = 1024 * 1024
SUPPORTED_CODECS = (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
DECODE_ERRORS = (zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError, OSError, zlib.error, ValueError)


def safe_filename(name):
    if not isinstance(name, str) or not name or len(name) > 255 or name in ('.', '..') or any(x in name for x in ('/', '\\', ':')) or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError('invalid filename; client paths are not accepted')
    return name


def safe_member(path):
    if not path or '\\' in path or ':' in path or path.startswith('/') or any(ord(c) < 32 or ord(c) == 127 for c in path):
        return False
    components = path.rstrip('/').split('/')
    return not any(x in ('', '.', '..') for x in components) and not PurePosixPath(path).is_absolute()


class BlobStore:
    def __init__(self, root):
        self.root = reject_symlinks(root)
        self.blobs = reject_symlinks(self.root / 'blobs')
        self.blobs.mkdir(mode=0o700, exist_ok=True)

    def path(self, digest):
        if not re.fullmatch('[0-9a-f]{64}', digest):
            raise ValueError('invalid blob identity')
        reject_symlinks(self.root)
        reject_symlinks(self.blobs)
        return reject_symlinks(self.blobs / digest)

    def put(self, stream):
        reject_symlinks(self.blobs)
        fd, name = tempfile.mkstemp(prefix='.pending-', dir=self.blobs)
        digest = hashlib.sha256(); size = 0
        created = False; target = None
        try:
            with os.fdopen(fd, 'wb') as out:
                while data := stream.read(65536):
                    size += len(data)
                    if size > UPLOAD_LIMIT:
                        raise OverflowError('upload exceeds 64 MiB')
                    digest.update(data); out.write(data)
                out.flush(); os.fsync(out.fileno())
            sha = digest.hexdigest(); target = self.path(sha)
            created = False
            try:
                os.link(name, target, follow_symlinks=False)
                created = True
                os.chmod(target, 0o400)
            except FileExistsError:
                self.read(sha, size)
            return sha, size, created
        except BaseException:
            if created and target is not None: target.unlink(missing_ok=True)
            raise
        finally:
            os.unlink(name)

    def read(self, digest, expected_size):
        path = self.path(digest)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as f:
            info = os.fstat(f.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size != expected_size or info.st_size > UPLOAD_LIMIT:
                raise ValueError('blob integrity failure')
            data = f.read(UPLOAD_LIMIT + 1)
        if len(data) != expected_size or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError('blob integrity failure')
        return data

    def discard(self, digest):
        self.path(digest).unlink(missing_ok=True)


def read_bounded(z, info):
    if info.file_size > MEMBER_LIMIT:
        raise ValueError('member exceeds 8 MiB')
    total = 0; pieces = []
    with z.open(info, 'r') as f:
        while part := f.read(min(65536, MEMBER_LIMIT + 1 - total)):
            total += len(part)
            if total > MEMBER_LIMIT or total > info.file_size:
                raise ValueError('member size limit or declared-size mismatch')
            pieces.append(part)
    if total != info.file_size:
        raise ValueError('member declared-size mismatch')
    return b''.join(pieces)


def preflight_zip(data):
    """Bound central-directory parsing before zipfile allocates its inventory."""
    import struct
    start = max(0, len(data) - 65557)
    eocd = data.rfind(b'PK\x05\x06', start)
    if eocd < 0 or eocd + 22 > len(data): return 'invalid ZIP end record'
    _, disk, central_disk, disk_count, count, size, offset, comment = struct.unpack_from('<4s4H2LH', data, eocd)
    if eocd + 22 + comment != len(data): return 'invalid ZIP comment or trailing data'
    if disk or central_disk or disk_count != count: return 'multi-disk ZIP is unsupported'
    if count == 65535 or size == 4294967295 or offset == 4294967295 or (eocd >= 20 and data[eocd - 20:eocd - 16] == b'PK\x06\x07'):
        return 'ZIP64 is unsupported'
    if count > MEMBER_COUNT_LIMIT: return 'member count exceeds 1000; inventory omitted before ZIP parser'
    if size > MEMBER_LIMIT: return 'central directory exceeds 8 MiB'
    pos = eocd - size
    if pos < 0 or offset > pos: return 'invalid central directory offset'
    actual_count = 0
    while pos < eocd:
        if pos + 46 > eocd or data[pos:pos + 4] != b'PK\x01\x02': return 'invalid central directory entry'
        name, extra, entry_comment = struct.unpack_from('<HHH', data, pos + 28)
        pos += 46 + name + extra + entry_comment
        actual_count += 1
        if actual_count > MEMBER_COUNT_LIMIT: return 'member count exceeds 1000; inventory omitted before ZIP parser'
    if pos != eocd or actual_count != count: return 'central directory count or size mismatch'
    return None


def inspect_zip(data):
    import io
    preflight_error = preflight_zip(data)
    if preflight_error:
        return {'archive_status': 'blocked', 'archive_errors': [preflight_error], 'members': []}
    members = []; errors = []; total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            infos = z.infolist()
            if len(infos) > MEMBER_COUNT_LIMIT:
                errors.append('member count exceeds 1000; inventory is bounded to first 1000 entries')
            seen = set()
            for info in infos[:MEMBER_COUNT_LIMIT]:
                diagnostics = []
                if not safe_member(info.orig_filename): diagnostics.append('unsafe member path')
                if info.filename in seen: diagnostics.append('duplicate member path')
                seen.add(info.filename)
                mode = info.external_attr >> 16
                if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                    diagnostics.append('symlink or special file is blocked')
                if info.flag_bits & 1: diagnostics.append('encrypted members are unsupported')
                if info.compress_type not in SUPPORTED_CODECS: diagnostics.append('unsupported compression codec; only stored and deflate are accepted')
                if info.file_size > MEMBER_LIMIT: diagnostics.append('member exceeds 8 MiB')
                total += info.file_size
                if total > ARCHIVE_TOTAL_LIMIT: diagnostics.append('total uncompressed size exceeds 64 MiB')
                if info.file_size / max(info.compress_size, 1) > RATIO_LIMIT: diagnostics.append('compression ratio exceeds 200')
                if not diagnostics:
                    try: read_bounded(z, info)
                    except DECODE_ERRORS: diagnostics.append('member decoder or CRC validation failed')
                members.append({'path': info.orig_filename, 'size': info.file_size, 'compressed_size': info.compress_size, 'is_directory': info.is_dir(), 'status': 'blocked' if diagnostics else 'valid', 'errors': diagnostics})
                errors.extend(f'{info.orig_filename}: {message}' for message in diagnostics)
    except DECODE_ERRORS:
        errors.append('invalid ZIP structure or inventory')
    return {'archive_status': 'blocked' if errors else 'valid', 'archive_errors': errors, 'members': members}


def member_bytes(data, path):
    import io
    if not safe_member(path):
        raise ValueError('unsafe member path')
    inventory = inspect_zip(data)
    if inventory['archive_status'] != 'valid':
        raise ValueError('archive is blocked')
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        try: info = z.getinfo(path)
        except KeyError: raise LookupError('member not found') from None
        return read_bounded(z, info)


def text_content(data, path=None):
    clipped = data[:TEXT_LIMIT]
    try:
        text = clipped.decode('utf-8'); encoded = None
    except UnicodeDecodeError:
        text = None; encoded = base64.b64encode(clipped).decode('ascii')
    return {'text': text, 'base64': encoded, 'size': len(data), 'truncated': len(data) > TEXT_LIMIT, 'path': path}
