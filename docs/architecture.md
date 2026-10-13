# Architecture

## Boundaries

```text
Greek React UI / authenticated API client / future MCP adapter
                          |
                 FastAPI /api/v1 + schemas
                          |
                Catalog application service
                   /                \
          SQLite transactions    Private blob store
```

- `backend/lab_catalog/schemas.py` defines the version-one wire contract, finite decimal strings, rubric validation and relationship payloads.
- `api.py` owns HTTP routing, authentication, exact Host/Origin checks, bounded requests, OpenAPI and inert downloads. It serves a whitelist of built frontend assets, not the private data directory.
- `service.py` owns catalog operations: explicit lab/team relationships, revisions, rubric changes, assessment history, evidence, overview and exports.
- `database.py` owns SQLite schema initialization, transactions, foreign keys and assessment-history protection. Each operation uses its own connection; ordinary history updates/deletes are rejected, while a confirmed cascade authorizes only its exact planned history IDs on that connection.
- `deletion.py` owns the deterministic scoped removal plan, distinct impact counts and full-state confirmation fingerprint. Preview and execution share the same planner; execution checks the fingerprint inside the write transaction and removes rows in foreign-key-safe order.
- `files.py` owns immutable SHA-256-addressed blobs, integrity validation and bounded read-only ZIP inspection. Uploaded code is never imported or executed.
- `frontend/src/` owns interaction and presentation. State is authoritative on the server; writes are confirmed by reads. The browser's in-progress forms are not the assessment database.

No HTTP handler starts a grader, student program, agent or subprocess. The executable CLI only starts the catalog server.

## Identity and ownership

Labs, teams, exercises, files, submissions and assessments have stable IDs. Team identity does not derive from the ordering or completeness of its members. Student identifiers are strings; leading zeros remain significant. Archive filenames do not assign membership.

Teams and exercises belong to one lab. A submission belongs to one explicit team. Materials can belong to a lab or a particular exercise. Evidence belongs to a team/exercise pair and may cite an explicit submission. Reference validation prevents cross-lab and cross-team associations; a shared lab material can be referenced by teams in that lab.

File metadata is separate from physical blob storage. Equal contents can share a blob while retaining distinct file/submission records and upload timestamps. Original bytes and filenames are retained; an unsafe archive is recorded as blocked rather than silently repaired.

## Scoring state

Maximum points and grading instructions belong to exercises. Active exercise maxima determine the lab total. Manual scoring accepts an explicitly assigned score. Criterion scoring validates each criterion and computes an exact decimal total from a complete set of scores.

An absent assessment has `score:null`, `status:ungraded` and revision zero. A deliberate score of `"0"` is different. Finalization requires an actual score; the overview includes only current-rubric finalized scores in awarded points. Completion requires all active exercises to be finalized against their current rubrics.

Each assessment update stores a rubric snapshot in immutable history. A grading-rule change increments the exercise's rubric revision. Previous assessments retain their original score, criterion values and instructions, and become visibly stale. Changing criterion labels is a grading-rule change; reordering criteria or renaming an exercise's display title is not a point conversion.

Evidence and notes can be recorded independently of finalization. A result attachment may contain test counts or agent findings, but those values do not assign or approve marks automatically. The `source` field records a caller-supplied human/agent/import label; it is not an authenticated user identity or a role boundary.

## Concurrent clients

Configuration/correction PATCH and assessment PUT require the current resource revision. Assessment PUT also requires the rubric revision actually loaded by the caller. Validation and both preconditions are checked inside the write transaction. An outdated editor receives a conflict rather than silently certifying rules it never loaded. Reassessing a stored stale grade requires explicit confirmation; unchanged notes/source corrections preserve its old snapshot and stale flag. PUT is a full replacement, so clients must include all fields they intend to retain.

Create POSTs are non-idempotent. The API explicitly rejects unsupported `Idempotency-Key` headers rather than pretending to deduplicate them. After an uncertain create response, inspect the collection before retrying. Independent intentional uploads are distinct versions.

## Extension

An MCP adapter should call the authenticated API and use its OpenAPI models, resource IDs and revision rules. It should not parse SQLite internals or reconstruct grading policy in a second storage layer. External graders and reviewers can attach structured evidence through the API; execution, provider selection and tool permissions remain outside this catalog.
