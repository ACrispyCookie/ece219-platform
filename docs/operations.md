# Operations

## Runtime and access

`make serve` launches the installed Python package with an explicit data directory, bind address and advertised Host. Defaults are `workspace/catalog`, `127.0.0.1` and port `3457`. The built frontend must exist; run `make build` first.

The CLI is also available directly:

```bash
.venv/bin/python -m lab_catalog serve \
  --data-dir workspace/catalog \
  --host 127.0.0.1 --port 3457 \
  --allowed-host 127.0.0.1:3457 \
  --frontend-dir frontend/dist
```

Repeat `--allowed-host` only for actual additional advertised authorities. A wildcard bind address requires an explicit advertised authority; wildcard Host allowlists are not accepted. The CLI disables forwarded-proxy-header trust by default and always disables access logging. It does not print the operator token.

The token file is `operator-token` inside the data directory, mode `0600`. Bearer requests and browser sessions grant access to the same single-operator catalog. Browser cookies expire after eight hours and use HttpOnly/SameSiteStrict; cookie-authenticated mutations require a matching Origin. Store the token securely and use HTTPS or a VPN for untrusted network paths. There are no user accounts, per-team permissions or automatic token-rotation endpoint.

The current deployment runs as the transient user service `ece219-platform.service`, with the repository as its working directory, the explicit LAN/proxy arguments below and restart-on-failure. This keeps the server independent of an agent task's lifetime. Inspect it with `systemctl --user status ece219-platform.service` and `journalctl --user -u ece219-platform.service`; stop it with `systemctl --user stop ece219-platform.service`. Restart after rebuilding so the static-asset allowlist is regenerated for the new hashed filenames. This transient deployment is not a boot-enabled service installation; after a reboot, launch it again or install a separately managed persistent unit.

## Reverse-proxy access

The current proxy on `192.168.1.2` routes `https://ece219.njason.dev` and `http://ece219.home.arpa` to the catalog on port3457. Preserve the original Host and let the proxy set `X-Forwarded-Proto`; do not rewrite Host to the upstream address.

```bash
make serve HOST=192.168.1.5 PORT=3457 \
  ALLOWED_HOSTS='192.168.1.5:3457 ece219.njason.dev ece219.home.arpa' \
  TRUSTED_PROXIES='192.168.1.2'
```

`ALLOWED_HOSTS` expands into repeated `--allowed-host` arguments. `TRUSTED_PROXIES` expands into repeated `--trusted-proxy` arguments, which accept literal unicast IPs only, not wildcard/subnet/hostname trust. Only a request arriving from an explicitly trusted proxy may use forwarded scheme/client headers. Forwarded Host is not used to bypass the exact Host check. Direct clients' spoofed forwarded scheme headers are ignored.

This preserves matching browser Origin validation behind HTTPS termination and produces Secure login cookies on the HTTPS domain. It does not enable CORS, remove authentication or trust every LAN client. Keep the proxy itself configured not to accept arbitrary client-supplied forwarding headers.

The home.arpa route currently uses HTTP on the trusted LAN/VPN. Its HTTPS listener presents an untrusted self-signed proxy certificate; application allowlists cannot repair that trust. Use a properly provisioned local CA/certificate before advertising HTTPS for that name; do not bypass certificate validation.

## Storage

A data directory contains:

- `catalog.sqlite3` and its SQLite WAL/shared-memory files while active;
- `blobs/` containing immutable content-addressed file bytes;
- `operator-token` for API access and signing sessions.

Do not edit the database or blob files behind the application's back. Blob downloads verify stored size and SHA-256. Symlink-based data paths are rejected. Schema version is stored in SQLite `user_version`; unsupported versions fail startup rather than being silently converted.

Schema version3 migrates history deletion protection transactionally. History remains immutable during ordinary operations, but explicitly confirmed cascades may delete their exact planned history rows. Back up the full data directory before upgrading; an older application cannot open version3 state.

Confirmed cascading deletion removes catalog records and attachment metadata, not blob bytes or separately held backups. This includes references used for downloads; once metadata is deleted it is no longer addressable through the API. Shared physical content is retained. There is no secure-erasure or garbage-collection operation.

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
- API text preview: 1 MiB; binary content in that JSON endpoint uses base64 rather than invented text.
- Browser preview fetches: 1 MiB for text and 16 MiB for PDF/raster images, checking both declared and actual streamed size. Archive-member limits remain independently enforced by the API.
- Raster preview: PNG, JPEG, GIF and WebP container/frame dimensions are checked before creating a browser image blob; at most 10,000,000 pixels per canvas/frame and 16,384 pixels per axis. Malformed, unsupported or oversized headers fall back to download. This is not a guarantee of total browser-process memory use.
- PDF canvas: one page at a time, at most 10,000,000 pixels and 16,384 pixels per axis; 25–300% zoom. Active annotations, forms and document scripts are not exposed.
- Point values: decimal strings, nonnegative, at most six fractional digits and at most 1,000,000,000 per exercise/criterion/score.

The API serves originals and safe member downloads as attachments with an inert MIME type, nosniff and sandbox CSP. It does not execute files or fetch evidence links. Archive inspection is bounded and read-only; blocking inspection does not remove original bytes.

Browser previews do not require exposing the private blob directory or weakening attachment headers. PDF viewing uses the reader and worker shipped in the frontend build; serve the complete built asset directory, not just the main JavaScript file. If a preview cannot load, check the authenticated file request and the built worker asset separately. Keep authentication, Host/Origin checks and inert download headers intact; the original download remains available when safe preview is unsupported.

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
