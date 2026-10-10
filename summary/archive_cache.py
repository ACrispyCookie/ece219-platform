"""Read-only archive intake; only validated regular members enter the local cache.

No extractall, shell, student-code execution, or writes to original archives.
RAR support requires 7z. Limits are conservative and failures remain explicit.
"""
from pathlib import Path, PurePosixPath
from typing import Any
import hashlib
import json
import lzma
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import zipfile
import zlib

# Support the legacy direct-script entry point as well as repository imports.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ece218.archive import _rar_entries

MAX_ARCHIVE_BYTES=128*1024*1024
MAX_FILE_BYTES=64*1024*1024
MAX_TOTAL_BYTES=256*1024*1024
MAX_MEMBERS=2000
MAX_RATIO=1000
_LOCK=threading.RLock()


def digest(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def safe_member(name):
    """Reject ambiguous names rather than normalizing an unsafe original token."""
    if not name or '\\' in name or any(ord(c)<32 for c in name) or ':' in name:
        raise ValueError('Unsafe member name: '+repr(name))
    if name.startswith('/') or any(p in ('','..','.') for p in name.split('/')):
        raise ValueError('Unsafe member path: '+repr(name))
    return PurePosixPath(name)


def no_symlinks(path):
    return all(not p.is_symlink() for p in (path,*path.parents))


def _sevenzip(args,output,limit):
    # Run the decoder with output/disk, memory, CPU and wall-clock limits.
    # A Python exec wrapper avoids preexec_fn's hazards in a threaded server.
    tool=shutil.which('7zz') or shutil.which('7z')
    if not tool:raise ValueError('RAR recovery requires 7zz or 7z; original remains unavailable')
    wrapper=('import os,resource,sys; '
             'resource.setrlimit(resource.RLIMIT_FSIZE,(int(sys.argv[1]),int(sys.argv[1]))); '
             'resource.setrlimit(resource.RLIMIT_AS,(536870912,536870912)); '
             'resource.setrlimit(resource.RLIMIT_CPU,(30,30)); '
             'os.execv(sys.argv[2],sys.argv[2:])')
    with output.open('xb') as out:
        result=subprocess.run([sys.executable,'-c',wrapper,str(limit),tool,*args],
                              stdin=subprocess.DEVNULL,stdout=out,stderr=subprocess.DEVNULL,
                              timeout=60,check=False)
    if result.returncode:raise ValueError('7z listing/extraction failed or exceeded resource limits')


def _rar_members(archive,stage):
    listing=stage/'listing.txt'
    _sevenzip(['l','-slt','-ba','-sccUTF-8','-p','--',str(archive)],listing,8*1024*1024)
    raw=listing.read_bytes();listing.unlink()
    return [dict(path=name,directory=folder,size=size,crc=crc)
            for name,folder,size,crc in _rar_entries(raw)]


def _validate(members,max_file_bytes,max_total_bytes):
    if len(members)>MAX_MEMBERS:raise ValueError('Archive member count limit exceeded')
    seen=set();total=0
    for member in members:
        name=member['path'];safe_member(name)
        if name in seen:raise ValueError('Duplicate archive member: '+name)
        seen.add(name)
        if member['size']<0 or member['size']>max_file_bytes:raise ValueError('Archive file size limit exceeded')
        if not member['directory']:total+=member['size']
    if total>max_total_bytes:raise ValueError('Archive total size limit exceeded')
    for member in members:
        if any(str(parent) in seen and not next(m['directory'] for m in members if m['path']==str(parent)) for parent in PurePosixPath(member['path']).parents if str(parent)!='.'):
            raise ValueError('Archive file/directory collision')


def recover_archive(archive,cache,*,max_file_bytes=MAX_FILE_BYTES,max_total_bytes=MAX_TOTAL_BYTES):
    """Return an inventory or an explicit blocked/unavailable state, never fake files."""
    archive=Path(archive).absolute();cache=Path(cache).absolute()
    result: dict[str,Any]=dict(archive=archive.name,status='unavailable',format=None,files=[],reason='')
    with _LOCK:
        stage=None
        try:
            safe_member(archive.name);safe_member(archive.stem)
            if not archive.is_file():result['reason']='Original archive absent';return result
            if not no_symlinks(archive) or not no_symlinks(cache):raise ValueError('Symlinked archive/cache rejected')
            if archive.stat().st_size>MAX_ARCHIVE_BYTES:raise ValueError('Compressed archive size limit exceeded')
            with archive.open('rb') as f:magic=f.read(8)
            fmt='zip' if magic.startswith((b'PK\x03\x04',b'PK\x05\x06',b'PK\x07\x08')) else 'rar' if magic.startswith(b'Rar!\x1a\x07') else None
            result['format']=fmt
            if not fmt:raise ValueError('Unsupported archive magic')
            sha=digest(archive);result['sha256']=sha
            target=cache/archive.stem
            if not no_symlinks(target):raise ValueError('Symlinked cache target rejected')
            if target.exists():
                index=target/'inventory.json'
                if not no_symlinks(index):raise ValueError('Symlinked cache inventory rejected')
                saved=json.loads(index.read_text())
                if saved.get('sha256')!=sha or saved.get('archive')!=archive.name:raise ValueError('Cache identity mismatch')
                _validate([dict(path=f['path'],size=f['size'],directory=False) for f in saved['files']],max_file_bytes,max_total_bytes)
                for file in saved['files']:
                    p=target/'members'/file['path']
                    if not no_symlinks(p) or not p.is_file() or p.stat().st_size!=file['size'] or digest(p)!=file['sha256']:
                        raise ValueError('Cached original changed or unavailable: '+file['path'])
                return saved
            cache.mkdir(parents=True,exist_ok=True)
            stage=Path(tempfile.mkdtemp(prefix='.recover-',dir=cache))
            if fmt=='zip':
                with zipfile.ZipFile(archive) as z:
                    members=[]
                    for info in z.infolist():
                        mode=info.external_attr>>16
                        if info.is_dir() and info.file_size:raise ValueError('ZIP directory contains payload data')
                        if stat.S_IFMT(mode) in (stat.S_IFREG,stat.S_IFDIR) and (stat.S_IFMT(mode)==stat.S_IFDIR)!=info.is_dir():raise ValueError('ZIP filename/type disagreement')
                        if info.flag_bits&1:raise ValueError('Encrypted ZIP member rejected')
                        if stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR):raise ValueError('ZIP symlink or special member rejected')
                        if info.file_size>max(1,info.compress_size)*MAX_RATIO:raise ValueError('ZIP compression ratio limit exceeded')
                        members.append(dict(path=info.filename[:-1] if info.is_dir() else info.filename,directory=info.is_dir(),size=info.file_size,info=info))
                    _validate(members,max_file_bytes,max_total_bytes)
                    for member in members:
                        p=stage/'members'/member['path']
                        if member['directory']:p.mkdir(parents=True,exist_ok=True);continue
                        p.parent.mkdir(parents=True,exist_ok=True)
                        with z.open(member['info']) as source,p.open('xb') as out:
                            written=0
                            while chunk:=source.read(64*1024):
                                written+=len(chunk)
                                if written>member['size'] or written>max_file_bytes:raise ValueError('ZIP decompressed size exceeded')
                                out.write(chunk)
                        if written!=member['size']:raise ValueError('ZIP decompressed size mismatch')
            else:
                members=_rar_members(archive,stage);_validate(members,max_file_bytes,max_total_bytes)
                if sum(m['size'] for m in members)>archive.stat().st_size*MAX_RATIO:raise ValueError('RAR compression ratio limit exceeded')
                for member in members:
                    p=stage/'members'/member['path']
                    if member['directory']:p.mkdir(parents=True,exist_ok=True);continue
                    p.parent.mkdir(parents=True,exist_ok=True)
                    _sevenzip(['x','-so','-spd','-ssc','-r-','-bd','-p','--',str(archive),member['path']],p,max(1,member['size']))
                    if p.stat().st_size!=member['size']:raise ValueError('RAR decompressed size mismatch')
                    if member['crc']:
                        crc=0
                        with p.open('rb') as source:
                            while chunk:=source.read(65536):crc=zlib.crc32(chunk,crc)
                        if crc!=int(member['crc'],16):raise ValueError('RAR archive CRC mismatch')
                result['decoder']='7zz' if shutil.which('7zz') else '7z'
            for member in members:
                if not member['directory']:
                    p=stage/'members'/member['path']
                    result['files'].append(dict(path=member['path'],size=p.stat().st_size,sha256=digest(p)))
            if digest(archive)!=sha:raise ValueError('Original archive changed during recovery')
            result.update(status='recovered',reason='')
            (stage/'inventory.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
            stage.rename(target);stage=None
            return result
        except (OSError,ValueError,KeyError,zipfile.BadZipFile,RuntimeError,subprocess.SubprocessError,zlib.error,lzma.LZMAError,EOFError) as exc:
            result.update(status='blocked',files=[],reason=str(exc));return result
        finally:
            if stage is not None:shutil.rmtree(stage)
