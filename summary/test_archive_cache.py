"""Safe original recovery: generated fixtures, never run student code."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import importlib
import os
import stat
import unittest
import zipfile

SCRATCH=Path(os.environ.get('TMPDIR',Path.home()/'.hermes/cache/scratch'))

class ArchiveRecoveryTests(unittest.TestCase):
    def recover(self, archive, cache, **kwargs):
        try:
            mod=importlib.import_module('archive_cache')
        except ModuleNotFoundError:
            self.fail('Safe archive recovery is not implemented')
        return mod.recover_archive(archive,cache,**kwargs)

    def test_zip_recovers_original_bytes_and_reuses_verified_cache(self):
        with TemporaryDirectory(dir=SCRATCH) as tmp:
            root=Path(tmp);archive=root/'team.zip';cache=root/'cache'
            with zipfile.ZipFile(archive,'w') as z:
                z.writestr('nested/source.asm',b'original assembly\n')
                z.writestr('theory.pdf',b'%PDF fixture')
            before=archive.read_bytes()
            result=self.recover(archive,cache)
            self.assertEqual(result['status'],'recovered')
            self.assertEqual(result['format'],'zip')
            self.assertEqual((cache/'team/members/nested/source.asm').read_bytes(),b'original assembly\n')
            self.assertEqual(archive.read_bytes(),before)
            self.assertEqual(len(result['files']),2)
            self.assertEqual(self.recover(archive,cache)['status'],'recovered')

    def test_corrupt_zip_codecs_are_blocked_without_partial_cache_and_batch_continues(self):
        import struct
        with TemporaryDirectory(dir=SCRATCH) as tmp:
            root=Path(tmp);cache=root/'cache';archives=[]
            for index,compression in enumerate([zipfile.ZIP_DEFLATED,zipfile.ZIP_BZIP2,zipfile.ZIP_LZMA]):
                source=root/f'bad{index}.zip';archives.append(source)
                with zipfile.ZipFile(source,'w',compression=compression) as archive:
                    archive.writestr('good.txt',b'good synthetic member\n')
                    archive.writestr('bad.asm',b'synthetic bytes; never executed\n')
                raw=bytearray(source.read_bytes())
                with zipfile.ZipFile(source) as archive:
                    offset=archive.getinfo('bad.asm').header_offset
                    name_size,extra_size=struct.unpack_from('<HH',raw,offset+26)
                    raw[offset+30+name_size+extra_size+(9 if compression==zipfile.ZIP_LZMA else 0)]=0xff
                source.write_bytes(raw)
            good=root/'healthy.zip';archives.append(good)
            with zipfile.ZipFile(good,'w',compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('answer.txt',b'healthy synthetic archive')
            before={p:p.read_bytes() for p in archives}
            for _ in range(2):
                results=[self.recover(source,cache) for source in archives]
                self.assertEqual([r['status'] for r in results],['blocked']*3+['recovered'])
                for result,source in zip(results[:3],archives[:3]):
                    self.assertEqual(result['files'],[])
                    self.assertTrue(result['reason'])
                    self.assertFalse((cache/source.stem).exists())
                self.assertEqual((cache/'healthy/members/answer.txt').read_bytes(),b'healthy synthetic archive')
                self.assertEqual(sorted(p.name for p in cache.iterdir()),['healthy'])
                self.assertEqual({p:p.read_bytes() for p in archives},before)

    def test_decoder_eof_and_lzma_errors_block_and_remove_legacy_stage(self):
        import lzma
        with TemporaryDirectory(dir=SCRATCH) as tmp:
            root=Path(tmp);source=root/'bad.zip';cache=root/'cache'
            with zipfile.ZipFile(source,'w') as archive:archive.writestr('answer.txt',b'synthetic')
            before=source.read_bytes()
            for error in [EOFError('truncated codec stream'),lzma.LZMAError('invalid codec stream')]:
                with self.subTest(error=type(error).__name__):
                    with patch.object(zipfile.ZipExtFile,'read',side_effect=error):
                        result=self.recover(source,cache)
                    self.assertEqual(result['status'],'blocked')
                    self.assertIn(str(error),result['reason'])
                    self.assertEqual(result['files'],[])
                    self.assertEqual(list(cache.iterdir()),[])
                    self.assertEqual(source.read_bytes(),before)

    def test_rejects_unsafe_names_without_extracting_any_member(self):
        for name in ['../outside.asm','/absolute.asm','C:/windows.asm','back\\slash.asm','a/../../escape','./alias.asm']:
            with self.subTest(name=name),TemporaryDirectory(dir=SCRATCH) as tmp:
                root=Path(tmp);archive=root/'bad.zip'
                with zipfile.ZipFile(archive,'w') as z:
                    z.writestr('valid.asm',b'ok');z.writestr(name,b'bad')
                result=self.recover(archive,root/'cache')
                self.assertEqual(result['status'],'blocked')
                self.assertFalse((root/'cache/bad/members').exists())

    def test_rejects_symlinks_duplicates_and_size_bombs(self):
        for kind in ['symlink','duplicate','oversize']:
            with self.subTest(kind=kind),TemporaryDirectory(dir=SCRATCH) as tmp:
                root=Path(tmp);archive=root/'bad.zip'
                with zipfile.ZipFile(archive,'w') as z:
                    if kind=='symlink':
                        info=zipfile.ZipInfo('link');info.create_system=3;info.external_attr=(stat.S_IFLNK|0o777)<<16
                        z.writestr(info,'/etc/passwd')
                    elif kind=='duplicate':
                        import warnings
                        with warnings.catch_warnings():
                            warnings.simplefilter('ignore');z.writestr('same.asm','a');z.writestr('same.asm','b')
                    else:z.writestr('huge.asm','x'*20)
                result=self.recover(archive,root/'cache',max_file_bytes=10)
                self.assertEqual(result['status'],'blocked')

    def test_directory_payload_and_file_directory_type_conflicts_are_blocked(self):
        for kind in ['directory_payload','regular_mode_directory_name','directory_mode_regular_name','prefix_conflict']:
            with self.subTest(kind=kind),TemporaryDirectory(dir=SCRATCH) as tmp:
                root=Path(tmp);archive=root/'bad.zip'
                with zipfile.ZipFile(archive,'w') as z:
                    if kind=='directory_payload':z.writestr('folder/',b'not directory data')
                    elif kind=='prefix_conflict':z.writestr('a','file');z.writestr('a/b.asm','child')
                    else:
                        info=zipfile.ZipInfo('folder/' if kind=='regular_mode_directory_name' else 'folder')
                        info.create_system=3;info.external_attr=((stat.S_IFREG if kind=='regular_mode_directory_name' else stat.S_IFDIR)|0o700)<<16
                        z.writestr(info,b'')
                result=self.recover(archive,root/'cache')
                self.assertEqual(result['status'],'blocked')
                self.assertFalse((root/'cache/bad').exists())

    def test_archive_magic_not_extension_controls_format(self):
        with TemporaryDirectory(dir=SCRATCH) as tmp:
            root=Path(tmp);archive=root/'actually-zip.rar'
            with zipfile.ZipFile(archive,'w') as z:z.writestr('source.asm','source')
            self.assertEqual(self.recover(archive,root/'cache')['format'],'zip')
            rar=root/'actually-rar.zip';rar.write_bytes(b'Rar!\x1a\x07\x01\x00'+b'not a valid rar')
            with patch('shutil.which',return_value=None):result=self.recover(rar,root/'cache')
            self.assertEqual(result['format'],'rar')
            self.assertEqual(result['status'],'blocked')
            self.assertIn('7z',result['reason'])

    def test_generated_stored_rar_recovers_exact_synthetic_bytes(self):
        import shutil,struct,zlib
        if not shutil.which('7z'):self.skipTest('Optional RAR decoder listing tool is unavailable')
        def header(kind,flags,payload):
            body=struct.pack('<BHH',kind,flags,7+len(payload))+payload
            return struct.pack('<H',zlib.crc32(body)&0xffff)+body
        name=b'synthetic.asm';content=b'synthetic original source\n'
        file_header=struct.pack('<IIBIIBBHI',len(content),len(content),3,zlib.crc32(content),0,20,0x30,len(name),0o100644)+name
        raw=b'Rar!\x1a\x07\x00'+header(0x73,0,b'\0'*6)+header(0x74,0x8000,file_header)+content+header(0x7b,0,b'')
        with TemporaryDirectory(dir=SCRATCH) as tmp:
            root=Path(tmp);archive=root/'synthetic.zip';archive.write_bytes(raw)
            result=self.recover(archive,root/'cache')
            self.assertEqual(result['format'],'rar')
            self.assertEqual(result['status'],'recovered',result['reason'])
            self.assertEqual((root/'cache/synthetic/members/synthetic.asm').read_bytes(),content)

    def rar_tool(self, root, *, crc='352441C2', body=b'abc', extraction_exit=0):
        import sys
        tool=root/'fixture-7zz'
        listing=('Path = source.asm\nFolder = -\nSize = 3\nPacked Size = 3\n'
                 'Attributes = A\nEncrypted = -\nCRC = '+crc+'\n\n')
        tool.write_text('#!'+sys.executable+'\nimport sys\n'
                        'if sys.argv[1] == "l":\n'
                        '    sys.stdout.write('+repr(listing)+')\n    sys.exit(0)\n'
                        'sys.stdout.buffer.write('+repr(body)+')\n'
                        'sys.exit('+repr(extraction_exit)+')\n')
        tool.chmod(0o700)
        return tool

    def test_full_7zz_is_preferred_over_distribution_7z(self):
        with TemporaryDirectory(dir=SCRATCH) as tmp:
            root=Path(tmp);archive=root/'synthetic.rar';archive.write_bytes(b'Rar!\x1a\x07\x00fixture')
            tool=self.rar_tool(root)
            with patch('shutil.which',side_effect=lambda name: str(tool) if name=='7zz' else '/missing/debian-7z'):
                result=self.recover(archive,root/'cache')
            self.assertEqual(result['status'],'recovered',result['reason'])
            self.assertEqual((root/'cache/synthetic/members/source.asm').read_bytes(),b'abc')

    def test_decoder_failure_is_blocked_without_native_fallback(self):
        with TemporaryDirectory(dir=SCRATCH) as tmp:
            root=Path(tmp);archive=root/'synthetic.rar';archive.write_bytes(b'Rar!\x1a\x07\x00fixture')
            tool=self.rar_tool(root,extraction_exit=2)
            with patch('shutil.which',return_value=str(tool)):
                result=self.recover(archive,root/'cache')
            self.assertEqual(result['status'],'blocked')
            self.assertIn('7z listing/extraction failed',result['reason'])
            self.assertNotIn('Native RAR',result['reason'])
            self.assertFalse((root/'cache/synthetic').exists())

    def test_rar_crc_mismatch_cannot_be_published_as_original(self):
        with TemporaryDirectory(dir=SCRATCH) as tmp:
            root=Path(tmp);archive=root/'synthetic.rar';archive.write_bytes(b'Rar!\x1a\x07\x00fixture')
            tool=self.rar_tool(root,body=b'abd')
            with patch('shutil.which',return_value=str(tool)):
                result=self.recover(archive,root/'cache')
            self.assertEqual(result['status'],'blocked',result)
            self.assertIn('CRC',result['reason'])
            self.assertEqual(result['files'],[])
            self.assertFalse((root/'cache/synthetic').exists())

    def test_tampered_or_symlinked_cache_is_not_trusted(self):
        with TemporaryDirectory(dir=SCRATCH) as tmp:
            root=Path(tmp);archive=root/'team.zip';cache=root/'cache'
            with zipfile.ZipFile(archive,'w') as z:z.writestr('source.asm','original')
            self.recover(archive,cache)
            target=cache/'team/members/source.asm';target.write_text('tampered')
            self.assertEqual(self.recover(archive,cache)['status'],'blocked')
            target.unlink();target.symlink_to(archive)
            self.assertEqual(self.recover(archive,cache)['status'],'blocked')

if __name__=='__main__':unittest.main()
