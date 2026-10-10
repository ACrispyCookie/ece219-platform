import copy
import importlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

try:
    Store = importlib.import_module('ece218.core').Store
except ModuleNotFoundError:
    Store = None


class Fixture(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Store, 'ingest Store is not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.src = self.base / 'inputs'
        self.src.mkdir()
        (self.src / 'submissions').mkdir()
        (self.src / 'rubric.txt').write_text('Exercise one: explain the answer.\nNo numerical rubric.\n')
        self.manifest = {'id': 'lab-a', 'title': 'Lab A',
                         'exercises': [{'id': 'one', 'title': 'One'}],
                         'materials': [{'role': 'guidelines', 'path': 'rubric.txt'}],
                         'submissions': 'submissions'}
        self.manifest_path = self.src / 'manifest.json'
        self.store = Store(self.base / 'private')

    def archive(self, name='0012_0345 - Δ.zip', members=None):
        path = self.src / 'submissions' / name
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
            for key, value in (members or {'α/answer.asm': 'addi a0, zero, 1\nret\n'}).items():
                z.writestr(key, value)
        return path

    def ingest(self):
        self.manifest_path.write_text(json.dumps(self.manifest))
        return self.store.import_lab(self.manifest_path)


class IngestTests(Fixture):
    def test_manifest_relative_parent_inputs_are_copied_without_output_traversal(self):
        self.archive()
        config = self.src / 'config'
        config.mkdir()
        self.manifest_path = config / 'manifest.json'
        self.manifest['materials'][0]['path'] = '../rubric.txt'
        self.manifest['submissions'] = '../submissions'
        try:
            self.ingest()
        except ValueError as exc:
            self.fail('valid relative manifest inputs rejected: ' + str(exc))
        material = self.store.detail('lab-a')['materials'][0]
        self.assertEqual(material['sourcePath'], '../rubric.txt')
        self.assertNotIn('..', material['path'].split('/'))
        self.assertEqual(self.store.material_path('lab-a', material['path']).read_text(), (self.src / 'rubric.txt').read_text())

    def test_material_and_exercise_metadata_preserved_in_inventory_and_bundle(self):
        self.archive()
        self.manifest['materials'][0]['suite'] = {'id': 'current-suite', 'bs': 19, 'substr': 22}
        self.manifest['exercises'][0]['weight'] = 2
        self.ingest()
        detail = self.store.detail('lab-a')
        self.assertIn('suite', detail['materials'][0], 'material metadata is lost')
        self.assertEqual(detail['materials'][0]['suite']['substr'], 22)
        self.assertEqual(detail['exercises'][0]['weight'], 2)
        self.store.prepare('lab-a')
        version = detail['teams'][0]['versions'][0]['id']
        bundle = self.store.bundle('lab-a', version)
        self.assertEqual(bundle['materials'][0]['suite']['bs'], 19)
        self.assertEqual(bundle['exercises'][0]['weight'], 2)

    def test_archive_format_uses_magic_not_extension(self):
        archive = self.archive('0012_0345.zip')
        archive.rename(archive.with_suffix('.data'))
        (archive.parent / '0012_0345-disguised.zip').write_bytes(b'Rar!\x1a\x07\x00not_a_real_rar')
        self.ingest()
        versions = self.store.detail('lab-a')['teams'][0]['versions']
        data = next(v for v in versions if v['archive'].endswith('.data'))
        rar = next(v for v in versions if v['archive'].endswith('.zip'))
        self.assertIn('format', data, 'detected archive format is missing')
        self.assertEqual(data['format'], 'zip')
        self.assertEqual(data['status'], 'pending')
        self.assertEqual(rar['format'], 'rar')
        self.assertEqual(rar['status'], 'blocked')
        self.assertIn('RAR', rar['errors'][0])

    def test_private_copy_unicode_and_preserved_leading_zero_identity(self):
        archive = self.archive()
        before = archive.read_bytes()
        result = self.ingest()
        self.assertEqual(result['id'], 'lab-a')
        detail = self.store.detail('lab-a')
        self.assertEqual(detail['teams'][0]['students'], ['0012', '0345'])
        version = detail['teams'][0]['versions'][0]
        self.assertEqual(version['status'], 'pending')
        self.assertEqual(version['exercises'], [])
        self.assertEqual(self.store.file_path('lab-a', version['id'], 'α/answer.asm').read_text(), 'addi a0, zero, 1\nret\n')
        archive.unlink()
        self.assertEqual(self.store.archive_path('lab-a', version['id']).read_bytes(), before)
        self.assertEqual(stat.S_IMODE(self.store.root.stat().st_mode), 0o700)
        self.assertEqual(self.store.list_labs()['labs'][0]['counts']['versions'], 1)

    def test_equal_content_named_duplicates_are_distinct_reimport_is_idempotent(self):
        first = self.archive()
        (first.parent / '0012_0345 - Δ(1).zip').write_bytes(first.read_bytes())
        self.ingest()
        self.ingest()
        versions = self.store.detail('lab-a')['teams'][0]['versions']
        self.assertEqual(len(versions), 2)
        self.assertNotEqual(versions[0]['id'], versions[1]['id'])

    def test_named_archive_needs_mapping_and_explicit_mapping_is_used(self):
        self.archive('lab1 - Nobody.zip')
        self.ingest()
        team = self.store.detail('lab-a')['teams'][0]
        self.assertEqual(team['students'], [])
        self.assertTrue(team['mappingNeeded'])
        self.manifest['teams'] = {'lab1 - Nobody.zip': ['0001', '0022']}
        self.ingest()
        team = self.store.detail('lab-a')['teams'][0]
        self.assertEqual(team['students'], ['0001', '0022'])
        self.assertFalse(team['mappingNeeded'])

    def test_traversal_absolute_windows_and_duplicate_members_blocked(self):
        for index, member in enumerate(['../escape', '/abs', 'C:/evil', 'a/../../escape', 'a\\evil']):
            self.archive(f'0012_0345-bad{index}.zip', {member: 'evil'})
        path = self.archive('0012_0345-duplicate.zip')
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('x', '1')
            z.writestr('x/../x', '2')
        self.ingest()
        versions = self.store.detail('lab-a')['teams'][0]['versions']
        self.assertEqual(len(versions), 6)
        self.assertTrue(all(v['status'] == 'blocked' for v in versions))
        self.assertFalse((self.base / 'escape').exists())

    def test_symlink_member_and_zip_bomb_and_corrupt_and_rar_blocked(self):
        path = self.src / 'submissions' / '0012_0345-link.zip'
        with zipfile.ZipFile(path, 'w') as z:
            info = zipfile.ZipInfo('link')
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            z.writestr(info, '/etc/passwd')
        self.archive('0012_0345-bomb.zip', {'bomb': '0' * 1_000_000})
        (path.parent / '0012_0345-corrupt.zip').write_bytes(b'not zip')
        (path.parent / '0012_0345-rar.rar').write_bytes(b'rar fixture')
        self.ingest()
        versions = self.store.detail('lab-a')['teams'][0]['versions']
        self.assertEqual(len(versions), 4)
        self.assertTrue(all(v['status'] == 'blocked' and v['errors'] for v in versions))

    def test_invalid_manifest_and_missing_material_rejected(self):
        self.archive()
        for change in [{'id': '../x'}, {'exercises': [{'id': 'one', 'title': 'One'}] * 2},
                       {'materials': [{'role': 'wat', 'path': 'rubric.txt'}]},
                       {'materials': [{'role': 'handout', 'path': 'missing.pdf'}]},
                       {'teams': {'bad.zip': [123]}}]:
            saved = copy.deepcopy(self.manifest)
            self.manifest.update(change)
            with self.assertRaises(ValueError):
                self.ingest()
            self.manifest = saved

    def test_symlink_input_and_symlink_storage_escape_rejected(self):
        self.archive()
        (self.src / 'rubric.txt').unlink()
        (self.src / 'rubric.txt').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):
            self.ingest()
        outside = self.base / 'outside'
        outside.mkdir()
        self.store.root.mkdir(exist_ok=True)
        (self.store.root / 'labs').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.store.detail('lab-a')

    def test_whitelisted_files_only_and_safe_ids(self):
        self.archive()
        self.ingest()
        version = self.store.detail('lab-a')['teams'][0]['versions'][0]['id']
        for path in ['../lab.json', '/etc/passwd', 'not-there']:
            with self.assertRaises((ValueError, FileNotFoundError)):
                self.store.file_path('lab-a', version, path)
        with self.assertRaises(ValueError):
            self.store.detail('../lab-a')


class RarTests(Fixture):
    def listing(self, name='α/answer.asm', size=3, **fields):
        values = {'Path': name, 'Folder': '-', 'Size': str(size), 'Packed Size': '3',
                  'Attributes': 'A', 'Encrypted': '-', 'Solid': '-', 'CRC': '352441C2',
                  'Symbolic Link': '', 'Hard Link': '', 'Copy Link': ''}
        values.update(fields)
        return '\n'.join(k + ' = ' + v for k, v in values.items()) + '\n\n'

    def tool(self, listing=None, outputs=None, listing_exit=0, extraction_exit=0, delay=0):
        # A real subprocess fixture exercises argv, output bounds, exit and timeout
        # without needing a RAR writer (7z only reads RAR).
        tool = self.base / 'fixture-7z'
        log = self.base / 'commands.jsonl'
        tool.write_text('#!' + sys.executable + '\n'
                        'import json, sys, time\n'
                        'with open(' + repr(str(log)) + ', "a") as f: f.write(json.dumps(sys.argv[1:]) + "\\n")\n'
                        'time.sleep(' + repr(delay) + ')\n'
                        'if sys.argv[1] == "l":\n'
                        '    sys.stdout.buffer.write(' + repr((listing if listing is not None else self.listing()).encode()) + ')\n'
                        '    sys.exit(' + repr(listing_exit) + ')\n'
                        'outputs = ' + repr(outputs if outputs is not None else {'α/answer.asm': b'abc'}) + '\n'
                        'sys.stdout.buffer.write(outputs.get(sys.argv[-1], b""))\n'
                        'sys.exit(' + repr(extraction_exit) + ')\n')
        tool.chmod(0o700)
        return patch('shutil.which', return_value=str(tool)), log

    def rar(self, name='0012_0345-disguised.zip'):
        path = self.src / 'submissions' / name
        path.write_bytes(b'Rar!\x1a\x07\x01\x00fixture')
        return path

    def version(self):
        return self.store.detail('lab-a')['teams'][0]['versions'][0]

    def test_full_7zz_is_preferred_when_both_readers_are_installed(self):
        self.rar()
        _, log = self.tool()
        full = str(self.base / 'fixture-7z')
        with patch('shutil.which', side_effect=lambda name: full if name == '7zz' else '/missing/debian-7z'):
            self.ingest()
        self.assertEqual(self.version()['status'], 'pending', self.version()['errors'])
        self.assertEqual(len(log.read_text().splitlines()), 2)

    def test_7z_is_used_when_full_7zz_is_unavailable(self):
        self.rar()
        _, log = self.tool()
        fallback = str(self.base / 'fixture-7z')
        with patch('shutil.which', side_effect=lambda name: fallback if name == '7z' else None):
            self.ingest()
        self.assertEqual(self.version()['status'], 'pending', self.version()['errors'])
        self.assertEqual(len(log.read_text().splitlines()), 2)

    def test_validated_rar_magic_unicode_exact_member_and_private_permissions(self):
        source = self.rar()
        original = source.read_bytes()
        name = 'α/[answer]*?.asm'
        mocked, log = self.tool(self.listing(name), {name: b'abc'})
        with mocked:
            self.ingest()
        version = self.version()
        self.assertEqual(version['status'], 'pending', version['errors'])
        self.assertEqual(version['format'], 'rar')
        out = self.store.file_path('lab-a', version['id'], name)
        self.assertEqual(out.read_bytes(), b'abc')
        self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o600)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(self.store.archive_path('lab-a', version['id']).read_bytes(), original)
        commands = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual([c[0] for c in commands], ['l', 'x'])
        self.assertIn('-slt', commands[0])
        self.assertIn('-so', commands[1])
        self.assertIn('-spd', commands[1])
        self.assertEqual(commands[1][-1], name)
        self.assertEqual(commands[1][-3], '--')

    def test_rar_validates_every_path_before_any_extraction(self):
        bad_paths = ['../escape', '/abs', 'C:/evil', 'a/../../escape', 'a\\evil',
                     './x', 'a//x', 'a\x00b', 'a\nb', '-option/../x']
        self.rar()
        for name in bad_paths:
            with self.subTest(name=name):
                mocked, log = self.tool(self.listing() + self.listing(name))
                with mocked:
                    self.ingest()
                version = self.version()
                self.assertEqual(version['status'], 'blocked')
                self.assertIn('unsafe', version['errors'][0].lower())
                self.assertTrue(all(json.loads(line)[0] == 'l' for line in log.read_text().splitlines()))
                self.assertFalse(self.store.path('lab-a', 'submissions', version['id']).exists())
                log.unlink()
        self.assertFalse((self.base / 'escape').exists())

    def test_rar_unix_attributes_with_empty_dos_prefix_are_regular_files(self):
        self.rar()
        mocked, _ = self.tool(self.listing(Attributes=' -rw-r--r--'))
        with mocked:
            self.ingest()
        self.assertEqual(self.version()['status'], 'pending', self.version()['errors'])

    def test_rar_blocks_links_reparse_special_encrypted_and_split_members(self):
        fields = [{'Symbolic Link': '/etc/passwd'}, {'Hard Link': 'other'}, {'Copy Link': 'other'},
                  {'Attributes': 'lrwxrwxrwx'}, {'Attributes': 'prw-------'},
                  {'Attributes': 'A R'}, {'Attributes': 'A_REPARSE'},
                  {'Encrypted': '+'}, {'Alternate Stream': '+'},
                  {'Split Before': '+'}, {'Split After': '+'}]
        self.rar()
        for metadata in fields:
            with self.subTest(metadata=metadata):
                mocked, log = self.tool(self.listing(**metadata))
                with mocked:
                    self.ingest()
                self.assertEqual(self.version()['status'], 'blocked')
                self.assertNotIn('unavailable in this backend', self.version()['errors'][0])
                self.assertTrue(all(json.loads(line)[0] == 'l' for line in log.read_text().splitlines()))
                log.unlink()

    def test_rar_rejects_invalid_sizes_duplicate_and_prefix_conflicts_before_extraction(self):
        from ece218.core import MAX_MEMBER, MAX_TOTAL, MAX_MEMBERS
        listings = [self.listing(size=-1), self.listing(size=MAX_MEMBER + 1),
                    self.listing(**{'Size': 'unknown'}), self.listing() + self.listing(),
                    self.listing('a') + self.listing('a/b'),
                    self.listing('a/b') + self.listing('a'),
                    self.listing() + 'Size = 3\n',
                    self.listing() + 'not a metadata line\n',
                    self.listing(**{'Folder': '?'}),
                    self.listing(**{'Encrypted': '?'}),
                    self.listing('d', size=1, Folder='+', Attributes='D'),
                    ''.join(self.listing(str(i), size=MAX_MEMBER) for i in range(MAX_TOTAL // MAX_MEMBER + 1)),
                    ''.join(self.listing(str(i), size=0) for i in range(MAX_MEMBERS + 1))]
        self.rar()
        for listing in listings:
            with self.subTest(listing=listing[:150]):
                mocked, log = self.tool(listing)
                with mocked:
                    self.ingest()
                version = self.version()
                self.assertEqual(version['status'], 'blocked')
                self.assertNotIn('unavailable in this backend', version['errors'][0])
                self.assertTrue(all(json.loads(line)[0] == 'l' for line in log.read_text().splitlines()))
                log.unlink()

    def test_rar_member_size_mismatch_or_tool_failure_cleans_all_outputs(self):
        self.rar()
        for body, status in [(b'ab', 0), (b'abcd', 0), (b'abc', 2)]:
            mocked, _ = self.tool(self.listing(), {'α/answer.asm': body}, extraction_exit=status)
            with mocked:
                self.ingest()
            version = self.version()
            self.assertEqual(version['status'], 'blocked')
            self.assertNotIn('unavailable in this backend', version['errors'][0])
            self.assertEqual(version['files'], [])
            self.assertFalse(self.store.path('lab-a', 'submissions', version['id']).exists())

    def test_rar_missing_tool_and_listing_errors_are_explicit(self):
        self.rar()
        with patch('shutil.which', return_value=None):
            self.ingest()
        self.assertIn('7z', self.version()['errors'][0])
        mocked, _ = self.tool(listing_exit=2)
        with mocked:
            self.ingest()
        self.assertEqual(self.version()['status'], 'blocked')
        self.assertIn('exit', self.version()['errors'][0].lower())

    def test_rar_solid_members_and_directories_supported_without_ratio_assumptions(self):
        self.rar()
        listing = (self.listing('folder', size=0, Folder='+', Attributes='D') +
                   self.listing('folder/a', size=3, Solid='+') +
                   self.listing('folder/b', size=3, Solid='+', **{'Packed Size': '0'}))
        mocked, log = self.tool(listing, {'folder/a': b'abc', 'folder/b': b'abc'})
        with mocked:
            self.ingest()
        version = self.version()
        self.assertEqual(version['status'], 'pending', version['errors'])
        self.assertEqual([f['memberPath'] for f in version['files']], ['folder/a', 'folder/b'])
        commands = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual([c[-1] for c in commands[1:]], ['folder/a', 'folder/b'])

    def test_rar_runtime_timeout_output_listing_and_diagnostic_bounds(self):
        self.rar()
        cases = [('RAR_TIMEOUT', 0.05, {'delay': 0.2}, 'timeout'),
                 ('MAX_LISTING', 10, {}, 'size limit'),
                 ('MAX_DIAGNOSTIC', 10, {'listing_exit': 2}, 'diagnostic limit')]
        for setting, limit, options, expected in cases:
            mocked, log = self.tool(**options)
            if setting == 'MAX_DIAGNOSTIC':
                tool = self.base / 'fixture-7z'
                text = tool.read_text().replace('import json, sys, time',
                                              'import json, sys, time\nsys.stderr.write("E" * 100)')
                tool.write_text(text)
            with mocked, patch('ece218.archive.' + setting, limit):
                self.ingest()
            version = self.version()
            self.assertEqual(version['status'], 'blocked')
            self.assertIn(expected, version['errors'][0].lower())
            self.assertEqual(version['files'], [])
            self.assertFalse(self.store.path('lab-a', 'submissions', version['id']).exists())
            log.unlink(missing_ok=True)  # Timeout may kill before fixture startup.

    def test_rar_crc_mismatch_and_late_member_failure_remove_earlier_output(self):
        self.rar()
        mocked, _ = self.tool(self.listing('good') + self.listing('bad'),
                              {'good': b'abc', 'bad': b'abd'})
        with mocked:
            self.ingest()
        version = self.version()
        self.assertEqual(version['status'], 'blocked')
        self.assertIn('CRC', version['errors'][0])
        self.assertEqual(version['files'], [])
        self.assertFalse(self.store.path('lab-a', 'submissions', version['id']).exists())

    def test_preserved_archive_tampering_cannot_be_recovered_by_overwriting_evidence(self):
        self.rar()
        with patch('shutil.which', return_value=None):
            self.ingest()
        version = self.version()
        preserved = self.store.archive_path('lab-a', version['id'])
        preserved.write_bytes(b'tampered')
        mocked, log = self.tool()
        with mocked:
            self.ingest()
        self.assertEqual(self.version()['status'], 'blocked')
        self.assertIn('hash mismatch', self.version()['errors'][0])
        self.assertEqual(preserved.read_bytes(), b'tampered')
        self.assertFalse(log.exists())

    def test_reimport_retries_blocked_rar_preserves_version_and_external_evidence(self):
        self.rar()
        with patch('shutil.which', return_value=None):
            self.ingest()
        first = self.version()
        evidence = self.store.path('lab-a', 'evidence', first['id'] + '.json')
        evidence.parent.mkdir(parents=True)
        evidence.write_text('{"source": "historical", "passed": 7}')
        archive_before = self.store.archive_path('lab-a', first['id']).read_bytes()
        mocked, log = self.tool()
        with mocked:
            self.ingest()
            self.ingest()
        version = self.version()
        self.assertEqual(version['status'], 'pending', version['errors'])
        self.assertEqual(version['id'], first['id'])
        self.assertEqual(self.store.detail('lab-a')['counts']['versions'], 1)
        self.assertEqual(version['errors'], [])
        self.assertEqual(version['evidence'], {'source': 'historical', 'passed': 7})
        self.assertEqual(self.store.archive_path('lab-a', first['id']).read_bytes(), archive_before)
        self.assertEqual(len(log.read_text().splitlines()), 2, 'successful reimports must not re-extract')


class IntakeRegressionTests(Fixture):
    def corrupt_compressed_archive(self, name, compression):
        import struct
        source=self.src/'submissions'/name
        with zipfile.ZipFile(source,'w',compression=compression) as archive:
            archive.writestr('good.txt',b'good synthetic member\n')
            archive.writestr('bad.asm',b'synthetic bytes; never executed\n')
        raw=bytearray(source.read_bytes())
        with zipfile.ZipFile(source) as archive:
            offset=archive.getinfo('bad.asm').header_offset
            name_size,extra_size=struct.unpack_from('<HH',raw,offset+26)
            payload=offset+30+name_size+extra_size
            # Keep inventory/CRC metadata valid, break only the compressed stream.
            # ZIP LZMA has a 9-byte version/properties header before range data.
            raw[payload+(9 if compression==zipfile.ZIP_LZMA else 0)]=0xff
        source.write_bytes(raw)
        return source

    def test_corrupt_deflate_stream_is_normalized_by_unzip(self):
        from ece218.archive import unzip
        import zlib
        source=self.corrupt_compressed_archive('0012_0345-bad.zip',zipfile.ZIP_DEFLATED)
        out=self.base/'decoder-test';out.mkdir()
        with self.assertRaisesRegex(ValueError,'ZIP decompression failed') as failed:
            unzip(source,out)
        self.assertIsInstance(failed.exception.__cause__,zlib.error)

    def test_corrupt_bzip2_stream_is_normalized_by_unzip(self):
        from ece218.archive import unzip
        source=self.corrupt_compressed_archive('0012_0345-bad.zip',zipfile.ZIP_BZIP2)
        out=self.base/'decoder-test';out.mkdir()
        with self.assertRaisesRegex(ValueError,'ZIP decompression failed') as failed:
            unzip(source,out)
        self.assertIsInstance(failed.exception.__cause__,OSError)

    def test_corrupt_zip_codecs_block_only_bad_archive_and_clean_partial_outputs(self):
        for index,compression in enumerate([zipfile.ZIP_DEFLATED,zipfile.ZIP_BZIP2,zipfile.ZIP_LZMA]):
            self.corrupt_compressed_archive(f'0012_0345-0bad{index}.zip',compression)
        self.archive('0012_0345-zgood.zip',{'answer.txt':b'healthy synthetic archive'})
        before={p:p.read_bytes() for p in (self.src/'submissions').iterdir()}
        for _ in range(2):
            detail=self.ingest()
            versions=[v for team in detail['teams'] for v in team['versions']]
            self.assertEqual(len(versions),4)
            good=next(v for v in versions if v['archive'].endswith('zgood.zip'))
            self.assertEqual(good['status'],'pending',good['errors'])
            self.assertEqual(self.store.file_path('lab-a',good['id'],'answer.txt').read_bytes(),b'healthy synthetic archive')
            for bad in [v for v in versions if v is not good]:
                with self.subTest(archive=bad['archive']):
                    self.assertEqual(bad['status'],'blocked')
                    self.assertTrue(bad['errors'])
                    self.assertEqual(bad['files'],[])
                    self.assertFalse(self.store.path('lab-a','submissions',bad['id']).exists())
            self.assertTrue(self.store.path('lab-a','lab.json').is_file())
            for version in versions:
                self.assertEqual(self.store.archive_path('lab-a',version['id']).read_bytes(),before[self.src/'submissions'/version['archive']])
        self.assertEqual({p:p.read_bytes() for p in before},before)

    def test_decoder_eof_and_lzma_errors_normalize_at_zip_reader_boundary(self):
        from ece218.archive import unzip
        import lzma
        source=self.archive()
        for index,error in enumerate([EOFError('truncated codec stream'),lzma.LZMAError('invalid codec stream')]):
            out=self.base/f'decoder-{index}';out.mkdir()
            # ZipExtFile read can raise these implementation-specific errors;
            # inject them at the real reader boundary, not at the Store API.
            with self.subTest(error=type(error).__name__),patch.object(zipfile.ZipExtFile,'read',side_effect=error):
                with self.assertRaisesRegex(ValueError,'ZIP decompression failed') as failed:
                    unzip(source,out)
                self.assertIs(failed.exception.__cause__,error)

    def test_zip_directory_data_type_conflicts_and_ambiguous_paths_are_blocked(self):
        cases = [('dir/', b'data', stat.S_IFDIR),
                 ('dir/', b'', stat.S_IFREG),
                 ('file', b'abc', stat.S_IFDIR),
                 ('a//', b'', stat.S_IFDIR)]
        for index, (name, body, mode) in enumerate(cases):
            with zipfile.ZipFile(self.src / 'submissions' / f'0012_0345-invalid{index}.zip', 'w') as z:
                info = zipfile.ZipInfo(name)
                info.external_attr = (mode | 0o600) << 16
                z.writestr(info, body)
        self.ingest()
        versions = self.store.detail('lab-a')['teams'][0]['versions']
        self.assertEqual(len(versions), len(cases))
        self.assertTrue(all(v['status'] == 'blocked' for v in versions))
        self.assertTrue(all(not self.store.path('lab-a', 'submissions', v['id']).exists() for v in versions))

    def test_zip_short_output_despite_matching_crc_is_blocked(self):
        import struct
        source = self.archive(members={'answer': b'abc'})
        raw = bytearray(source.read_bytes())
        local = raw.index(b'PK\x03\x04')
        central = raw.index(b'PK\x01\x02')
        struct.pack_into('<I', raw, local + 22, 4)
        struct.pack_into('<I', raw, central + 24, 4)
        source.write_bytes(raw)
        self.ingest()
        version = self.store.detail('lab-a')['teams'][0]['versions'][0]
        self.assertEqual(version['status'], 'blocked')
        self.assertIn('size mismatch', version['errors'][0])
        self.assertEqual(version['files'], [])

    def test_zip_validates_prefix_conflicts_before_writing_any_member(self):
        from ece218.core import unzip
        source = self.archive(members={'a/b': 'abc', 'a': 'xyz'})
        out = self.base / 'extracted'
        out.mkdir()
        with self.assertRaisesRegex(ValueError, 'prefix conflict'):
            unzip(source, out)
        self.assertEqual(list(out.iterdir()), [])

    def test_counts_separate_confirmed_teams_from_unresolved_groups_and_versions(self):
        first = self.archive('0012_0345.zip')
        (first.parent / '0012_0345(1).zip').write_bytes(first.read_bytes())
        self.archive('Somebody.zip')
        self.archive('Nobody.zip')
        counts = self.ingest()['counts']
        self.assertEqual(counts['versions'], 4)
        self.assertEqual(counts['teams'], 3)
        self.assertEqual(counts.get('confirmedTeams'), 1)
        self.assertEqual(counts.get('unresolved'), 2)
        self.manifest['teams'] = {'Somebody.zip': ['0012', '0345']}
        counts = self.ingest()['counts']
        self.assertEqual(counts['teams'], 2)
        self.assertEqual(counts['confirmedTeams'], 1)
        self.assertEqual(counts['unresolved'], 1)

    def test_corrupt_zip_crc_remains_blocked_on_every_reimport_without_partial_files(self):
        source = self.src / 'submissions' / '0012_0345-corrupt.zip'
        with zipfile.ZipFile(source, 'w', zipfile.ZIP_STORED) as z:
            z.writestr('good.txt', b'good')
            z.writestr('answer.pdf', b'original-pdf-data')
        source.write_bytes(source.read_bytes().replace(b'original-pdf-data', b'corrupted-pdf---x'))
        before = source.read_bytes()
        for _ in range(2):
            self.ingest()
            version = self.store.detail('lab-a')['teams'][0]['versions'][0]
            self.assertEqual(version['status'], 'blocked')
            self.assertIn('CRC', version['errors'][0])
            self.assertEqual(version['files'], [])
            self.assertFalse(self.store.path('lab-a', 'submissions', version['id']).exists())
            self.assertEqual(self.store.archive_path('lab-a', version['id']).read_bytes(), before)
        self.assertEqual(source.read_bytes(), before)


class RealArchiveIntegrationTests(Fixture):
    @unittest.skipUnless(os.environ.get('ECE218_REAL_ARCHIVES') == '1',
                         'opt-in read-only integration against local original archives')
    def test_real_intake_all_four_rars_truthful_counts_and_original_preservation(self):
        from ece218.core import detect_format, sha
        source_manifest = Path(__file__).resolve().parents[1] / 'Lab1' / 'lab.json'
        if not source_manifest.is_file():
            self.skipTest('local original Lab1 inputs are not present')
        data = json.loads(source_manifest.read_text())
        original_base = source_manifest.parent
        submissions = original_base / data['submissions']
        originals = [p for p in submissions.iterdir() if p.is_file()]
        rar_paths = [p for p in originals if detect_format(p) == 'rar']
        self.assertEqual(len(rar_paths), 4)
        self.assertTrue(any(p.suffix == '.zip' for p in rar_paths))
        before = {p: sha(p) for p in originals}
        zip_paths = [p for p in originals if detect_format(p) == 'zip']
        self.assertEqual(len(zip_paths), 57)
        for path in zip_paths:
            with zipfile.ZipFile(path) as archive:
                self.assertIsNone(archive.testzip(), 'original ZIP CRC failure: ' + path.name)
        for material in data['materials']:
            path = original_base / material['path']
            before[path] = sha(path)
            material['path'] = os.path.relpath(path, self.src)
        data['submissions'] = os.path.relpath(submissions, self.src)
        self.manifest = data
        detail = self.ingest()
        counts = detail['counts']
        self.assertEqual(counts['versions'], 61)
        self.assertEqual(counts['teams'], 57)
        self.assertEqual(counts['confirmedTeams'], 55)
        self.assertEqual(counts['unresolved'], 2)
        self.assertEqual(counts['blocked'], 0)
        self.assertEqual(counts['pending'], 61)
        versions = [v for team in detail['teams'] for v in team['versions']]
        rar_versions = [v for v in versions if v['format'] == 'rar']
        self.assertEqual(len(rar_versions), 4)
        self.assertTrue(all(v['status'] == 'pending' and v['files'] for v in rar_versions))
        for version in rar_versions:
            for file in version['files']:
                self.assertTrue(self.store.file_path(data['id'], version['id'], file['memberPath']).is_file())
        for version in versions:
            copied_archive = self.store.archive_path(data['id'], version['id'])
            self.assertEqual(sha(copied_archive), before[submissions / version['archive']])
        self.assertEqual({p: sha(p) for p in before}, before)
        detail2 = self.ingest()
        self.assertEqual(detail2['counts'], counts)
        self.assertEqual({p: sha(p) for p in before}, before)


if __name__ == '__main__':
    unittest.main()
