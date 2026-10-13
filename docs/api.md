# API workflows

The authoritative machine-readable contract is `/openapi.json`; `/docs` exposes the same operations interactively. All catalog routes use `/api/v1`. IDs returned by the server are the relationship keys; do not reconstruct IDs from labels, filenames or student membership.

## Authentication

API clients send `Authorization: Bearer` with the private operator token. Browser login uses `POST /api/v1/session` with `{ "token": "..." }`, then an expiring HttpOnly cookie. `GET /api/v1/session` reports `authenticated`; DELETE signs the browser out. Do not put tokens in query parameters.

Cookie-authenticated mutations require an exact matching browser Origin. Non-browser Bearer clients do not need an Origin header; an explicitly supplied hostile Origin is still rejected. Host must match an advertised authority including its port.

This is one operator authority. `source:human|agent|import` is provenance supplied by the caller, not an authorization role or a verified personal identity.

## Resource flow

1. **Create a lab:** `POST /labs` with `title` and optional `description`.
2. **Configure exercises:** `POST /labs/{lab_id}/exercises` with title, maximum points, grading mode and instructions. Preserve returned criterion IDs when editing a rubric.
3. **Upload teaching material:** `POST /labs/{lab_id}/files` as multipart `file`; then POST `/labs/{lab_id}/materials` with the returned `file_id`, role, title, description and optional `exercise_id`.
4. **Create a team:** POST `/labs/{lab_id}/teams` with label, members, `membership_complete` and optional notes. A team with only known individuals can remain incomplete.
5. **Upload a submission:** POST `/labs/{lab_id}/teams/{team_id}/submissions` as multipart `file`. The team association is explicit. Every successful upload is a new submission record, even with identical content.
6. **Assess an exercise:** GET then PUT `/labs/{lab_id}/teams/{team_id}/assessments/{exercise_id}` using the returned revision and all intended assessment fields.
7. **Attach evidence:** POST `/labs/{lab_id}/teams/{team_id}/evidence` with `exercise_id`, evidence kind and content. An optional `submission_id` records which explicit version supports it.

The paths above are relative to `/api/v1`. Collection GETs return `{items,total,limit,offset}`. Use `limit` from 1 to 200 and `offset` from zero, and continue until all requested records have been collected. Overview uses `rows` instead of `items` because it contains a team/exercise matrix plus lab-wide statistics.

### Exercise payload examples

These are synthetic request examples, not seed records:

```json
{
  "title": "Explanation",
  "position": 0,
  "max_points": "3.00",
  "grading_mode": "manual",
  "grading_instructions": "Assign points after reviewing the explanation."
}
```

```json
{
  "title": "Implementation",
  "position": 1,
  "max_points": "7.00",
  "grading_mode": "criteria",
  "grading_instructions": "Record each criterion explicitly.",
  "criteria": [
    {"id": "correctness", "label": "Correctness", "max_points": "5.00", "instructions": "Inspect output and edge cases."},
    {"id": "explanation", "label": "Explanation", "max_points": "2.00", "instructions": "Review reasoning."}
  ]
}
```

Point values are decimal **strings**, not JSON floats. They must be finite, nonnegative, within configured bounds and have at most six fractional digits. Criteria must sum exactly to the exercise maximum. The lab maximum is derived from active exercises; there is no separate manually maintained lab-total field.

## Updates and conflict handling

GET the resource before editing. Lab, exercise, team, material and evidence PATCH bodies require its current `revision`. Assessment PUT requires its current revision (zero when absent) **and the `rubric_revision` of the exercise actually loaded by the editor**. A conflicting assessment or rubric revision receives HTTP409 with structured details. Never substitute a freshly fetched revision into an old draft without comparing the rules.

For a stored stale assessment, changing grading values against current rules also requires explicit `confirm_rubric_change:true`. A genuine notes/source-only correction without that confirmation preserves the original score, rubric snapshot and stale state; it cannot certify the new rubric. Partial criterion drafts retain their supplied points and a null aggregate until every criterion is present.

Assessment PUT is a **full replacement**. Include notes, submission association, criterion scores, status and source that should remain present. Omitted fields use request defaults; PUT is not a patch.

An absent assessment has a null score, ungraded status and revision zero. A deliberate `"0"` is an assigned score. Final assessments require an actual score; criterion finalization requires all configured criteria. Criterion totals are computed on the server rather than trusting a client-provided inconsistent aggregate.

The API records each saved assessment revision in immutable history. GET `.../assessments/{exercise_id}/history` uses normal pagination. Changing grading instructions, maxima, criterion labels or other substantive rubric rules increments `rubric_revision`; old assessments retain their score and rubric snapshot and report `rubric_stale:true`. Reassess against current rules explicitly rather than converting historical scores automatically.

Create POSTs are non-idempotent. `Idempotency-Key` is currently unsupported and rejected. After a timeout or uncertain create response, inspect the collection before retrying; an intentional repeated upload creates a distinct version. Revision checks provide concurrency control for updates, not deduplication for creates.

## Evidence

Evidence is independent of whether the exercise has a score:

- `text`: title plus text observation.
- `link`: title plus absolute HTTP(S) URL without embedded credentials. The server does not fetch it.
- `file`: title plus `file_id`; upload the file first, with multipart `team_id` when team-specific.
- `result`: title plus finite JSON `data`; for example an external test result or an agent's structured findings. This does not assign a grade.

The web editor preserves integer literals exactly, including values outside JavaScript's safe integer range. It rejects duplicate decoded object keys before parsing or writing, including escaped-equivalent and special keys; an invalid draft remains in the editor and makes no create/update request. Metadata-only corrections omit unchanged result content rather than reparsing and resending it. Decimal/exponent numbers entered in the editor must round-trip through finite binary64 without changing their decimal value; unsupported precision, overflow and underflow are rejected before the write. Use JSON strings for precise decimals, as the grading API already does. The backend continues to accept arbitrary-precision integer values within its JSON/parser/request bounds. Invalid Unicode scalar strings or keys are rejected as structured validation errors, not silently normalized.

All kinds include `exercise_id` and optional `submission_id` and `source`. List/filter through GET `/labs/{lab_id}/teams/{team_id}/evidence?exercise_id=...`. DELETE the explicit evidence resource to remove an attachment association.

Use the exact material/evidence item GET and revision-controlled PATCH routes to correct roles, titles, content and associations while retaining the resource ID. Replacing a file association does not overwrite the original blob. DELETE remains available for removing an association.

Cross-lab exercise/file references and another team's submission/file are rejected. Shared lab files can be referenced within their lab. Material roles are `handout`, `grader`, `solution`, `guidelines` and `other`; graders are stored without execution.

## Files and archives

File metadata is available at `/files/{file_id}`; originals are downloaded from `/files/{file_id}/download`. Responses are inert attachments with size/hash validation. Private filesystem paths are not part of the contract.

GET `/submissions/{submission_id}` reports archive status and diagnostics. GET its `/members` collection for the bounded inventory. Safe original member bytes are downloaded from `/members/content?path=...`; the bounded JSON preview is a separate `/members/text?path=...` operation. Use the exact member path returned by the inventory. Blocked archives retain their original bytes but do not expose unsafe member downloads. ZIP support and size/codec limits are described in [operations](operations.md).

No original or included source file is interpreted or executed. There is no HTTP endpoint to launch graders or agents.

## Overview, export and deletion

GET `/labs/{lab_id}/overview` provides dynamic exercise columns, paged team rows, assessments, submission counts, derived totals and completion state. Awarded points include only finalized scores using the current rubric. `grade_complete` is false while any active exercise is missing, draft or stale.

GET `/labs/{lab_id}/export` returns the full lab's metadata, file references, submissions, evidence, assessments and assessment history with a schema version. It does not include original file bytes; download/backup those separately.

Use `archived:true` with a revision-controlled PATCH when a lab, exercise or team should remain available but inactive. The web interface's **Delete** actions instead perform confirmed cascading deletion.

### Preview, confirm and delete

All eight resource paths support GET `{path}/deletion-impact` and DELETE `{path}`:

- `/labs/{lab_id}`
- `/labs/{lab_id}/exercises/{exercise_id}`
- `/labs/{lab_id}/teams/{team_id}`
- `/labs/{lab_id}/materials/{material_id}`
- `/labs/{lab_id}/files/{file_id}`
- `/labs/{lab_id}/teams/{team_id}/submissions/{submission_id}`
- `/labs/{lab_id}/teams/{team_id}/evidence/{evidence_id}`
- `/labs/{lab_id}/teams/{team_id}/assessments/{exercise_id}`

Impact includes positive, distinct per-table `cascade_counts` and a SHA-256 `confirmation_token` covering the complete plan and relevant record state. The older `dependencies`, bounded `unreferenced_files` preview (at most 50) and full `unreferenced_files_total` remain for restrictive-client diagnostics; they do not limit cascade execution.

Show the actual target and `cascade_counts` to the operator, then send `DELETE {path}?cascade=true&confirmation_token={token}` only after confirmation. Include the displayed positive `revision` for labs, exercises, teams, materials, evidence and assessments; files/submissions are immutable and have no revision precondition. Ownership, revision and the recomputed plan are checked in the same write transaction. A changed plan returns `409 deletion_changed` without deleting anything: fetch a fresh preview and ask for confirmation again, never automatically retry.

Without `cascade=true`, legacy restrictive deletion remains available and rejects dependent records. A missing or malformed cascade token returns422. Invalid cross-owner associations or surviving references that would require deleting outside the requested scope return409 with no changes.

### What is removed

- **Lab:** its teams, exercises, materials, submissions, files, evidence, assessments and assessment history.
- **Team:** its submissions, evidence, assessments/history and team-owned uploads. The lab, exercises, sibling teams and shared lab uploads survive.
- **Exercise:** associated materials, evidence and assessments/history, plus newly unreferenced attachment metadata. Teams and their submission versions survive.
- **Submission:** linked evidence and assessments whose current or historical submission association targets that version, including those assessments' history. Other versions survive.
- **Assessment:** that grade and its history; independent evidence remains.
- **Material/evidence:** the selected record and its attached file metadata only when no surviving reference uses it.
- **Upload:** referencing materials, submissions and evidence within its lab, plus their linked assessment/history descendants and newly unreferenced attachments. Other file IDs and other labs survive.

Deletion is atomic and respects foreign keys. Assessment history remains immutable during ordinary operations; only the exact history IDs in an explicitly confirmed cascade are authorized for deletion on that transaction's connection.

**This removes catalog records, not securely erased bytes.** Immutable content-addressed blobs and separately held backups remain private, including content shared with surviving records. No uploaded archive is rewritten; individual ZIP member entries are not separate editable entities.

### Verification and interface behavior

After204, verify exact-item GET404. File/submission readback uses `/files/{file_id}` and `/submissions/{submission_id}`. Assessment GET remains200 with `id:null`, revision zero, null score and ungraded status; its history must also be empty.

The interface places compact Delete controls next to each item's management/view/download actions. It fetches the preview under shared synchronous mutation ownership, then displays a styled in-app modal with the target, server removal-count cards and an irreversible-action warning. Cancel receives initial focus; Cancel, Close, Escape and a backdrop click dismiss the confirmation without sending DELETE and restore focus to the trigger. During deletion and readback, the modal shows progress and cannot be dismissed or confirmed twice. Lists/routes/editors update only after readback. Unsaved drafts are guarded, pending saves/uploads cannot race removal, and conflicts retain the current view. Deletion warnings have accessible local-only close controls that restore focus and emit no HTTP mutation.

## Responses

Successful creates return201, reads/updates200 and supported deletions204. Error bodies are `{code,message,details}`. Important statuses include401 authentication,404 missing/scoped-away resource,409 revision/integrity/reference conflict,413 upload limit and422 invalid input. Unknown request fields are rejected rather than ignored. Clients should render structured validation details and preserve unsaved drafts on failure.
