# ECE219 · Lab Catalog

A private, API-first platform for organizing teaching labs, teams, submissions and exercise assessments. One Greek web interface provides lab setup, a team-by-exercise overview, grading, notes and evidence. Labs and rubrics are configured through the application rather than through lab-specific scripts.

## What it stores

- **Labs and materials:** handouts, graders, solutions, grading guidelines and other attachments, optionally associated with an exercise.
- **Exercises and grading rules:** maximum points, instructions, manual scoring or a criterion-based rubric. The lab's point total is derived from its active exercises.
- **Teams:** literal student identifiers, optional names, incomplete memberships and team notes.
- **Submission versions:** original ZIP bytes, hashes, explicit team associations and bounded member inventories. Uploading the same bytes again creates a separate version.
- **Exercise assessments:** scores, draft/final status, an optional explicit submission association, notes and immutable revision history.
- **Evidence:** text, links, attached files and structured result data, independent of whether a score has been assigned.

Uploaded graders and student code are **stored, never executed**. Evidence does not automatically become a mark. Changing a rubric retains previous scores and flags them for review.

## Requirements

- Python 3.11 or newer and [uv](https://docs.astral.sh/uv/), or an equivalent Python environment manager.
- Node.js 22.12 or newer and npm for building and developing the frontend.
- A local filesystem for SQLite and private file storage.

The application does not require Docker, Java, an LLM provider or Hermes.

## Setup and run

From the repository root:

```bash
uv sync --locked --extra dev
npm --prefix frontend ci
make build
make serve
```

Open `http://127.0.0.1:3457/`. The server initializes an empty catalog under `workspace/catalog/`. It generates an operator access token in `workspace/catalog/operator-token`; copy its contents into the application's login form using a local password manager or trusted local interface. Do not put the token in URLs, source files or shared chat.

The default listener is loopback. To bind to a trusted LAN interface, supply the machine's actual address:

```bash
make serve HOST=192.168.1.5 PORT=3457
```

Host and browser Origin checks require the exact advertised address and port. Authentication is still required on the LAN. Use a VPN or an HTTPS deployment when traffic crosses an untrusted network; the CLI does not terminate TLS and ignores forwarded proxy headers unless an explicit reverse-proxy IP is trusted. See [reverse-proxy access](docs/operations.md#reverse-proxy-access) for the ECE219 domains.

## Using the application

1. Create a lab and upload its teaching materials.
2. Add exercises, assign maximum points and define their grading instructions. Criterion-based rubrics must sum exactly to the exercise maximum.
3. Create teams and enter known members. Keep incomplete memberships explicitly incomplete.
4. Upload the team's ZIP submissions. Open a particular version to inspect its files; use the same control again to hide them. Viewing contents does not automatically associate that version with an assessment.
5. Open an exercise tab for the team. Save a draft or final assessment, notes and evidence. A blank grade is not a zero.
6. Use the overview to inspect completion and outstanding work, or export the lab's metadata and assessment history as JSON.

Assessment and configuration changes require the current revision. Conflicts preserve the editor's draft rather than overwriting another client's changes.

Supported files can be previewed in the browser while retaining a separate download action. PDFs are rendered by the application viewer, source/text files are displayed without execution, and supported raster images are shown as images. Unsupported or oversized files retain a download fallback. Uploaded HTML, SVG and scripts are never opened as active same-origin documents. The original file and archive-member bytes remain unchanged.

Evidence and material corrections open beside the item being edited. Technical identifiers and raw result JSON remain available in expandable details rather than dominating the default view. Assessment deletion is grouped with the assessment itself, separate from the exercise's grading instructions.

Compact Delete controls are available for labs, exercises, teams, materials, submissions, assessments, evidence and uploads. The confirmation names the target and shows the related records that will be removed; deleting a higher-level entity removes its contained catalog records in one transaction, including relevant assessment history. Archive remains a non-destructive alternative. Stored blob bytes and separate backups are retained—catalog deletion is not secure erasure. See [deletion scope and confirmation](docs/api.md#preview-confirm-and-delete).

## API and agent clients

- Versioned REST API: `/api/v1`
- Interactive schema: `/docs`
- Machine-readable OpenAPI: `/openapi.json`
- Minimal public liveness endpoint: `/health`

Agent clients authenticate with `Authorization: Bearer` using the operator token. The web interface uses an expiring HttpOnly session cookie; it does not persist the token in browser local storage. This is a **single-operator** application, not a multi-user permissions system.

See [API workflows](docs/api.md) for resource relationships, decimal values, revisions and uploads. A future MCP adapter can use this API without duplicating storage or grading logic; an MCP server is not included.

## Repository layout

```text
backend/lab_catalog/  HTTP API, schemas, application service, SQLite and files
backend/tests/        Synthetic API, storage, security and persistence tests
frontend/src/         Unified React/TypeScript web application and component tests
frontend/dist/        Built frontend served by the Python application
pyproject.toml        Python dependencies and package configuration
uv.lock               Resolved Python dependency lock
Makefile              Build, check and run commands
docs/                 Architecture, API workflows and operations
workspace/catalog/    Private runtime state; not application source
```

See [architecture](docs/architecture.md) for ownership boundaries and [operations](docs/operations.md) for storage, backups and failure handling.

## Frontend development

Run an isolated API on its development port:

```bash
.venv/bin/python -m lab_catalog serve \
  --data-dir workspace/catalog-development \
  --host 127.0.0.1 --port 3460 \
  --allowed-host 127.0.0.1:3460
```

In another terminal:

```bash
npm --prefix frontend run dev
```

Open `http://127.0.0.1:5173/` and use the token from the development data directory. Vite binds to loopback, uses a strict port, and proxies API/docs/schema requests to `127.0.0.1:3460`. The proxy translates only the exact legitimate development Origin; it does not bypass authentication or accept hostile Origins. For the production same-origin layout, use `make build` and `make serve` instead.

## Verification

```bash
make check
make build
```

`make check` runs backend and frontend tests plus TypeScript checks. Tests use synthetic fixtures; production starts without demonstration records.

For a separate catalog, change the data directory rather than replacing the database in an active server:

```bash
make serve DATA_DIR=workspace/another-catalog PORT=3459
```
