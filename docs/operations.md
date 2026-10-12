# Operations

## Runtime and access

`make serve` launches the installed Python package with an explicit data directory, bind address and advertised Host. Defaults are `workspace/catalog`, `127.0.0.1` and port `3458`. The built frontend must exist; run `make build` first.

The CLI is also available directly:

```bash
.venv/bin/python -m lab_catalog serve \
  --data-dir workspace/catalog \
  --host 127.0.0.1 --port 3458 \
  --allowed-host 127.0.0.1:3458 \
  --frontend-dir frontend/dist
```

Repeat `--allowed-host` only for actual additional advertised authorities. A wildcard bind address requires an explicit advertised authority; wildcard Host allowlists are not accepted. The CLI disables forwarded-proxy-header trust and access logging. It does not print the operator token.

The token file is `operator-token` inside the data directory, mode `0600`. Bearer requests and browser sessions grant access to the same single-operator catalog. Browser cookies expire after eight hours and use HttpOnly/SameSiteStrict; cookie-authenticated mutations require a matching Origin. Store the token securely and use HTTPS or a VPN for untrusted network paths. There are no user accounts, per-team permissions or automatic token-rotation endpoint.

## Storage

A data directory contains:

- `catalog.sqlite3` and its SQLite WAL/shared-memory files while active;
- `blobs/` containing immutable content-addressed file bytes;
- `operator-token` for API access and signing sessions.

Do not edit the database or blob files behind the application's back. Blob downloads verify stored size and SHA-256. Symlink-based data paths are rejected. Schema version is stored in SQLite `user_version`; unsupported versions fail startup rather than being silently converted.

## Backups and restores

A metadata JSON export is **not** a full file backup. Back up the whole data directory, including blobs and the token, separately from application source.

For the simplest consistent snapshot, stop the catalog process cleanly, copy/archive its entire data directory, and then restart it. Do not copy just an active `catalog.sqlite3`: committed state may still be in its WAL. Keep backup archives private. Restore to an unused directory, launch the application against it, and verify lab metadata, assessment history and byte-identical downloads before switching the normal listener.

Deleting the token file and restarting generates a replacement and invalidates existing API tokens and signed browser sessions. Coordinate that operation with every client; never delete it from a running deployment as a substitute for a supported rotation workflow.

## Limits

- Original file: 64 MiB.
- Multipart request including framing: 65 MiB, checked before multipart parsing.
- Other request bodies: 1 MiB; JSON nesting: 64 levels.
- ZIP members: at most 1000, 8 MiB each, 64 MiB total uncompressed; maximum compression ratio 200.
- ZIP codecs: stored and DEFLATE. Encrypted, multi-disk and ZIP64 submissions remain preserved but blocked for member inspection.
- Text preview: 1 MiB. Binary preview data uses base64 rather than invented text.
- Point values: decimal strings, nonnegative, at most six fractional digits and at most 1,000,000,000 per exercise/criterion/score.

The API serves originals and safe member downloads as attachments with an inert MIME type, nosniff and sandbox CSP. It does not execute files or fetch evidence links. Archive inspection is bounded and read-only; blocking inspection does not remove original bytes.

## Diagnosing failures

- **401:** authenticate, or sign in again if the cookie expired. Tokens are not query-string parameters.
- **Invalid Host:** use the exact advertised hostname/IP and port. Updating a bind address alone does not authorize a different URL.
- **Origin rejected:** use the same-origin production UI. Do not disable checks or add wildcard CORS.
- **409 revision conflict:** fetch current state, compare it with the unsaved draft, and explicitly reapply intended changes. Do not blindly replace the revision and resubmit old fields.
- **409 integrity conflict:** restore missing/corrupt blob bytes from a verified backup; do not replace stored hashes to conceal corruption.
- **422:** inspect structured validation details. Unknown input fields, invalid references, rubric sums and incomplete final assessments are rejected.
- **413:** reduce the actual upload/request size. A small compressed ZIP can still exceed uncompressed inspection limits.
- **Blocked archive:** keep its original; request a corrected submission as a new explicit version if needed.

The repository's private pre-catalog data is separate from the new catalog. It is not imported automatically at startup.
