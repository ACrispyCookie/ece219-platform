# Lab 1 grading summary

Private CSV-first review dashboard with a Greek interface, an overview, and per-group detail pages. The authoritative input is **`lab1_results_by_student.csv` at the repository root**. This dashboard never runs the grader, edits original submissions, or changes CSV decisions.

## Run from the repository root

```bash
python3 summary/start_server.py
```

Open **http://127.0.0.1:3457/summary/**. The default bind is loopback. To explicitly allow trusted LAN access, choose the bind interface and advertised address:

```bash
python3 summary/start_server.py --host 0.0.0.0 --hostLAN 192.0.2.10 --port 3457
# Open http://192.0.2.10:3457/summary/
```

Replace the documentation address `192.0.2.10` with your actual LAN IPv4 address or hostname. A nonlocal bind requires `--hostLAN`; the bind wildcard is not an advertised hostname. GET and HEAD require exactly one Host matching the advertised name and actual bound port. Loopback defaults accept `127.0.0.1` and `localhost` with that port; Host checks are not authentication.

This exposes private student data to reachable LAN clients; the server does not provide authentication. It serves only dashboard assets, the source CSV, exact available original/evidence links, and the listed Lab 1 reference materials—not the repository, Python implementation, `.git`, `.env`, or `workspace/`. Both GET and HEAD enforce the same restrictions. All non-dashboard files are inert `application/octet-stream` attachments with `nosniff` and a restrictive sandbox CSP; only trusted dashboard assets retain their browser MIME types. Source previews still use inventory data; original PDF/image links download rather than render in the dashboard origin. An existing process needs a deliberate restart to load server-code changes.

The read-only `/summary/api/data` endpoint rereads CSV input on every request. Reload the page after changing the CSV. It does not watch or execute grading code. Stop with Ctrl+C.

## Originals and availability

Original ZIP/RAR archives live in **`Lab1/submissions/`**. The builder detects format by magic bytes, not extension, and recovers validated regular members additively under:

```text
.submission-cache/<exact archive stem>/members/<exact member path>
```

This ignored cache is private, derived data. Original archives, manual `Lab1/teams/` files and CSV inputs remain untouched. The builder checks paths, duplicate names, special files/links, encryption, file and total sizes, compression ratios, and cache hashes. It rejects ambiguous paths instead of normalizing traversal, absolute paths, or backslashes.

ZIP recovery uses Python's standard library. RAR recovery prefers a full `7zz` build over `7z`: some distribution `7z` packages can list RAR metadata but lack the RAR decoder. Each exact member is streamed to a Python-owned file with resource limits and verified size/CRC. Decoder failure stays blocked; there is no automatic native/libarchive fallback, disk-extraction API, or invented grading evidence.

A verified Linux arm64 installation uses the official **7-Zip 26.03** release:

- Download: https://github.com/ip7z/7zip/releases/download/26.03/7z2603-linux-arm64.tar.xz
- Package SHA-256 (also published in the GitHub release asset metadata): `2389ba20e4d8295e8709c20b6263b69bd1ec4972fe38a04ad7a1badbf595b996`
- `7zz` binary SHA-256: `9a26e7d54bfdae8a8f1750cdb70697547b738c2334aa89f3d3f2c8645c8443fe`

Install the official binary in a user-local versioned directory and put `7zz` on the server's PATH. No system package or sudo change is required. Other architectures need their corresponding official package, not the arm64 binary.

Limits per archive: compressed input 128 MiB, ZIP member 64 MiB/total 256 MiB, RAR member 32 MiB/total 128 MiB, 2,000 members, maximum compression ratio 1,000. RAR metadata uses the shared strict validator in `ece218/archive.py`; decoding also has memory, CPU, output-size and wall-clock bounds. Cache reuse verifies original and member hashes; altered cache data is not silently trusted.

Each version includes an original-archive download link. Source previews and PDF/scanned-image document links refer to real recovered originals without requiring a grading manifest. Unavailable logs remain unavailable. Page previews are listed only when those page-image files really exist; this tool does not render or invent them.

For a genuinely absent original source, an existing embedded code preview is retained as **imported snapshot evidence**, not a freshly read file. Source differences against an imported preview are recorded separately (`snapshotContentMismatch` and `importedSnapshotContent`); they do not alter historical test results or imply that those tests were rerun against the recovered file.

## Offline snapshot

```bash
python3 summary/build_data.py
```

Before updating `summary/report-data.json` and `summary/data.js`, the builder preserves the original imported JSON byte-for-byte in **`.submission-cache/.baseline/report-data.original.json`**. Subsequent refreshes do not overwrite that baseline.

Open `summary/index.html` directly for offline use. It uses `data.js`; live CSV reads require the local server. Keep the repository layout and recovered cache alongside `summary/` for original-file links. No internet is required.

## Interpretation and notes

- CSV group/student identities, archive selection, theory decisions, tests, scores and review notes remain authoritative. Partner-row disagreements are rejected rather than silently resolved.
- Auxiliary manifests and imported snapshots can enrich document/output previews, never override CSV outcomes.
- Historical function and console tests remain separate. The saved CSV suite uses 19 binary-search / 25 substring tests; the current `Lab1/grade.py` defines 19 / 22. Historical results are not presented as current-grader reruns.
- Archive ordering does not establish newest, best, final, or equivalent code. Source provenance and instructor decisions require separate review.
- Missing exercises are missing, not zero or invented runs. Scores are not final course grades; ABI, oral understanding and other instructor criteria still need review.
- Evaluator notes live only in this browser's localStorage. JSON export/import backs them up; it does not edit CSV or send notes to the server. Changing origin/port or clearing browser data can remove access to stored notes.

## Reusable recovery API

`summary/archive_cache.py` exposes:

```python
recover_archive(archive_path, cache_root,
                max_file_bytes=MAX_FILE_BYTES,
                max_total_bytes=MAX_TOTAL_BYTES)
```

The returned dictionary contains `archive`, `status` (`recovered`, `blocked`, or `unavailable`), detected `format`, `reason`, `files` (exact member path, byte size and SHA-256), and the archive SHA-256 when available. Recovered RAR inventories also identify `decoder`. Successful inventories are saved as `<cache>/<stem>/inventory.json`; member paths resolve below its sibling `members/` directory. Keep the repository's `ece218/archive.py` alongside this helper for shared RAR metadata validation. Safety helpers `safe_member`, `no_symlinks`, and `digest` are shared with the data builder/server.

## Checks

Public code tests use only generated synthetic fixtures:

```bash
python3 -m unittest discover -s summary -v
node --test summary/frontend.test.cjs
```

Optional actual-input integration checks and recovery reports are local-only ignored cache artifacts. They are not committed as test fixtures. Test execution never runs student code or the grader.
