"""Bounded native RAR decoder worker. No archive-controlled disk extract API.

Called only after 7z metadata validation; libarchive independently verifies
member identity/type/size while streaming into exact, exclusive-create paths.
"""
from pathlib import Path
import ctypes as C
import ctypes.util
import json
import os
import resource
import stat
import sys

from archive_cache import safe_member,no_symlinks,_validate


def decode(archive,stage,metadata,max_file,max_total):
    resource.setrlimit(resource.RLIMIT_FSIZE,(max_file,max_file))
    resource.setrlimit(resource.RLIMIT_AS,(512*1024*1024,512*1024*1024))
    resource.setrlimit(resource.RLIMIT_CPU,(30,30))
    members=json.loads(Path(metadata).read_text())
    _validate(members,max_file,max_total)
    expected={m['path']:m for m in members}
    library=ctypes.util.find_library('archive')
    if not library:raise ValueError('7z cannot decode RAR and native libarchive is unavailable')
    lib=C.CDLL(library)
    def api(name,result,*args):
        fn=getattr(lib,name);fn.restype=result;fn.argtypes=list(args);return fn
    ptr=C.c_void_p;integer=C.c_int
    new=api('archive_read_new',ptr)
    filters=api('archive_read_support_filter_all',integer,ptr)
    rar=api('archive_read_support_format_rar',integer,ptr)
    rar5=api('archive_read_support_format_rar5',integer,ptr)
    open_archive=api('archive_read_open_filename',integer,ptr,C.c_char_p,C.c_size_t)
    next_header=api('archive_read_next_header',integer,ptr,C.POINTER(ptr))
    pathname=api('archive_entry_pathname_utf8',C.c_char_p,ptr)
    filetype=api('archive_entry_filetype',C.c_uint,ptr)
    filesize=api('archive_entry_size',C.c_int64,ptr)
    symlink=api('archive_entry_symlink',C.c_char_p,ptr)
    hardlink=api('archive_entry_hardlink',C.c_char_p,ptr)
    encrypted=api('archive_entry_is_encrypted',integer,ptr)
    read=api('archive_read_data',C.c_ssize_t,ptr,ptr,C.c_size_t)
    error=api('archive_error_string',C.c_char_p,ptr)
    free=api('archive_read_free',integer,ptr)
    handle=new();seen=set();total=0;buffer=C.create_string_buffer(65536)
    def check(code):
        if code<0:raise ValueError((error(handle) or b'Native RAR decoding failed').decode('utf-8',errors='replace'))
    try:
        check(filters(handle));check(rar(handle));check(rar5(handle))
        check(open_archive(handle,os.fsencode(archive),65536))
        while True:
            entry=ptr();code=next_header(handle,C.byref(entry))
            if code==1:break
            check(code)
            raw=pathname(entry)
            if not raw:raise ValueError('RAR UTF-8 pathname unavailable')
            name=raw.decode('utf-8',errors='strict').rstrip('/') if filetype(entry)==stat.S_IFDIR else raw.decode('utf-8',errors='strict')
            safe_member(name)
            if name in seen or name not in expected:raise ValueError('RAR metadata identity mismatch: '+name)
            seen.add(name);member=expected[name]
            kind=filetype(entry)
            if kind not in (stat.S_IFDIR,stat.S_IFREG) or symlink(entry) or hardlink(entry) or encrypted(entry):
                raise ValueError('RAR link, encryption or special file rejected')
            if (kind==stat.S_IFDIR)!=member['directory'] or filesize(entry)!=member['size']:
                raise ValueError('RAR metadata size/type mismatch: '+name)
            target=Path(stage)/'members'/name
            if not no_symlinks(target):raise ValueError('RAR output symlink rejected')
            if kind==stat.S_IFDIR:target.mkdir(parents=True,exist_ok=True);continue
            target.parent.mkdir(parents=True,exist_ok=True)
            written=0
            with target.open('xb') as out:
                while True:
                    count=read(handle,buffer,len(buffer));check(count)
                    if count==0:break
                    written+=count;total+=count
                    if written>member['size'] or written>max_file or total>max_total:raise ValueError('Native RAR output size limit exceeded')
                    out.write(buffer.raw[:count])
            if written!=member['size']:raise ValueError('Native RAR decompressed size mismatch')
        if seen!=set(expected):raise ValueError('Native RAR member inventory incomplete')
    finally:free(handle)

if __name__=='__main__':
    try:decode(sys.argv[1],sys.argv[2],sys.argv[3],int(sys.argv[4]),int(sys.argv[5]))
    except Exception as exc:
        print(str(exc)[:512],file=sys.stderr);sys.exit(1)
