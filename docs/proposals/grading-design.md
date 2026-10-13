# Grading system — proposed design for approval

**Status:** review proposal, not an implemented API. Existing grading, execution restrictions and authentication remain unchanged until the user supplies the approved design.

**Companion contract:** `grading-api.openapi.json` defines the proposed HTTP paths and wire types. Paths in this document are relative to `/api/v1`. The proposal extends the catalog; it does not replace existing exercises, submissions, assessments or evidence.

## 1. Requirements and chosen boundaries

The requested feature is automatic and agentic grading, including hybrid use, with MCP access. The API and abstraction must be reviewed before implementation.

Current code provides stable exercise/criterion IDs, exact decimal scores, explicit submission versions, revision-guarded assessments, rubric snapshots/history, independent evidence and confirmed hierarchical deletion. It has no executor, job queue, grading proposal model, worker permissions or MCP adapter. `grading_mode: manual|criteria` describes scoring shape, not execution strategy. `source: agent` is caller-supplied provenance, not authorization.

Decisions:

1. Keep the catalog authoritative. All writes use its application service, transactions and ownership checks. No MCP/worker writes SQLite directly.
2. HTTP requests enqueue work; a separate supervised worker executes it. The API process never starts student programs or grading agents.
3. Separate evaluation from assessment approval. Graders produce immutable results/proposals; only the operator accepts or edits a proposal into an assessment.
4. One durable **run** is also the queued job. Its execution attempts and tasks are separate records. Do not add redundant job and run objects representing the same request.
5. Select a specific submission ID. Never silently choose newest/best, infer team membership from filenames, or reuse results from another upload merely because hashes match.
6. Rubric points stay decimal strings, using the current catalog bounds. The server validates and computes totals. Unknown/unresolved is null, not zero.
7. Support automatic, agentic and hybrid execution through narrow adapters. Do not put provider names, simulator commands or a generic workflow engine into the catalog service.
8. MCP is a thin, permission-limited adapter over the same API. It is not the executor, scheduler, assessment database or an authentication substitute.
9. Initial release requires operator review for every proposal. Automatic finalization is not included in this proposal.
10. Use SQLite for durable coordination and one worker initially. Separate automatic and agent execution slots prevent an agent waiting for tests from blocking the tests it requested. Redis, arbitrary DAGs, multi-user accounts and student-facing publication are not prerequisites.

## 2. Architecture and abstractions

```text
Greek UI / operator API client       MCP-capable grading agent
               |                                |
               |                       scoped MCP adapter
               |                                |
               +-------- catalog/grading API ----+
                                    |
                  grading application service + SQLite
                                    |
                    persisted tasks / leases / results
                                    |
                      separate worker supervisor
                       /                       \
           automatic-runner adapter       agent-runner adapter
                       |                       |
               isolated execution      scoped tools + approved
                                        model-provider connector
```

Interfaces and responsibilities:

- **GradingService:** plan activation, run creation, queue transitions, fenced completion, proposal assembly, acceptance and scoped reads. Owns no runtime imports or model calls.
- **AutomaticRunner:** consumes a frozen task context and approved configuration; produces typed check results, criterion evaluations and artifact references. An adapter is selected by registry ID, not client shell commands.
- **AgentRunner:** starts a bounded agent session, enforces model/tool/time/cost limits, supplies approved context, and completes the task with a validated staged evaluation.
- **SandboxSupervisor:** creates isolated execution environments, enforces resource/egress policy, terminates process trees, and separates trusted supervision from student-controlled output.
- **ProviderConnector:** resolves an approved provider/model and a local secret reference outside stored grading plans. It does not own grading policy.
- **MCPAdapter:** maps the agent tools in section 9 to scoped HTTP calls, preserves IDs/preconditions and reports structured errors.

Adapters are installed/approved operator configuration. The capability API lists the actual registry entries and their configuration schemas. Uploaded `grader` material remains inert until explicitly referenced in an approved active grading plan. No endpoint accepts host paths, arbitrary commands, arbitrary container images or a provider URL.

## 3. Domain model

### GradingPlan

An immutable, exercise-owned configuration version. Creation captures the current scoring rubric and its semantic signature. Creating a plan does not activate it or execute anything. Plan compatibility uses a **scoring signature** (maxima, scoring mode, criteria and instructions, excluding the active plan pointer and revision counters); assessment staleness uses the broader **grading signature**, which also includes the approved plan identity/hash. Activation must not make its own plan incompatible. Activating a different immutable plan version deliberately stales earlier grades even if its author believes the versions equivalent; only re-selecting the same plan is a no-op.

Fields include:
- ID, lab/exercise ownership, per-exercise version, creator/timestamp and canonical definition hash.
- Frozen scoring rubric and basis rubric revision.
- Optional automatic runner configuration: registry ID/version, grader upload ID/hash, declared check groups and validated adapter parameters.
- Optional agent configuration: registered provider/model, instructions, approved context material IDs, allowed check groups, external-processing authorization and budget limits.
- Criterion policies, or one whole-exercise policy for existing manual-score exercises.
- Named submission-input requirements (`file`/`file_set` cardinality and content kind) and an explicit run budget: maximum attempts, total/on-demand concurrent checks, aggregate CPU and output.
- Server-generated material snapshots: source material ID/revision, immutable file ID/hash and access purpose.

For criterion scoring, each current criterion ID appears exactly once with evaluator `automatic`, `agent` or `human`. One criterion has one primary scoring owner: hybrid combines different owners, not duplicate points. An agent may discuss automatic results but cannot replace an automatic-owned score. Human-owned criteria remain unresolved until review.

For manual scoring, `overall_policy` assigns the single whole-exercise score. Do not invent a reserved criterion ID that can collide with user-defined IDs.

Allowed modes are derived: automatic requires an automatic configuration; agentic requires an agent configuration; hybrid requires both. A run in a narrower mode may produce a partial proposal. In agentic mode, approved on-demand checks can produce automatic-owned evaluations; the agent still cannot supply their marks itself.

### Active plan binding

`PUT /labs/{lab}/exercises/{exercise}/grading-plan` selects a plan ID or null. It requires current exercise and rubric revisions plus `approve_execution:true` for a non-null plan. The plan must match current scoring semantics and all referenced registry entries must be enabled. A later incompatible rubric edit leaves the binding visibly incompatible and blocks new runs until a compatible plan is activated; assignments are never inferred by label/order.

Changing the binding changes grading rules and increments the exercise revision and rubric revision atomically. Extend the existing rubric signature/snapshot with the active plan identity/definition hash. Re-selecting the same binding is a no-op. Manual assessment writes continue to work with no active plan.

Plan snapshots pin files, not mutable material pointers. Replacing or renaming teaching material does not silently change an approved plan. New content requires a new plan and activation. Plan creation/activation also validates the material ownership and explicit visibility purpose.

### GradingRun, RunAttempt and Task

- **Run:** operator request for one lab/team/exercise/submission, exact mode and active plan. Stores a frozen input manifest, rubric/plan snapshots and the assessment ID/revision plus persistent assessment-slot generation observed at enqueue. Mutable execution lifecycle; immutable input definition.
- **Attempt:** one execution generation. An explicit retry creates another attempt under the same run, using the same inputs. Attempt-scoped artifacts/results never overwrite earlier attempts.
- **Task:** automatic or agent work owned by one attempt. Hybrid schedules the initial automatic task before the agent task. Approved on-demand check tasks are a bounded extension of this sequence, not a general graph.

Run creation supplies named `input_bindings` whose exact member paths satisfy the plan's named input requirements. Paths come from the selected submission's safe inventory; the UI can expand “all files” into an explicit list but the API accepts no implicit latest/wildcard/folder guessing. An input manifest contains those exact safe archive-member paths, logical input names, sizes/hashes, approved material snapshots, and registered runtime/provider versions. ZIP traversal, unsafe/blocked archives, unsupported members or absent required paths fail before execution. Original bytes are never modified. Run creation can validate only inert structure/configuration; an execution/preflight failure is still a recorded run failure, not an invented grade.

### Result and artifact

Typed results contain check outcomes, criterion evaluations, unresolved items, observable evidence references and execution provenance. Agent rationales are concise reviewable explanations, not private chain-of-thought transcripts.

Artifacts are immutable attempt/task-owned objects: logs, normalized reports and generated files. They are not ordinary team uploads and cannot be supplied as arbitrary file IDs during completion. Artifact uploads are private inert bytes with hash/size validation and explicit visibility. Downloads retain attachment/sandbox/nosniff protections.

### GradeProposal

One assembled immutable candidate per completed attempt. Store individual criterion/overall evaluations, score/null, feedback, evidence references, provenance and unresolved items. The server validates ownership, criterion IDs and ranges, and computes the total.

Proposal states are `pending`, `accepted`, `rejected`; stale eligibility is derived separately. A failed/cancelled run does not produce a normal proposal. Partial grading is a successful execution with unresolved criteria, not infrastructure failure.

### ProposalDecision

An immutable operator decision links the proposal to the created assessment-history revision, records acceptance/rejection, optional complete operator replacement values and the reviewed basis. Do not repurpose the existing `source` string as actor identity. Accepted assessments keep `source:human`, and gain nullable origin fields for run/proposal/decision IDs; corresponding history snapshots retain these references and the evaluated policy snapshot.

## 4. Public workflow and API

### Capabilities and plan setup

- `GET /grading/capabilities`: approved automatic runners, provider/models, adapter parameter schemas and deployment policy ceilings; no secrets.
- `GET|POST /labs/{lab}/exercises/{exercise}/grading-plans`: list/create immutable versions.
- `GET /labs/{lab}/exercises/{exercise}/grading-plans/{plan}`: definition, snapshots and derived compatibility.
- `GET|PUT /labs/{lab}/exercises/{exercise}/grading-plan`: current binding / explicit approval and activation or disable.

Example plan definition for criterion scoring (illustrative identifiers, not seed data):

```json
{
  "rubric_revision": 4,
  "title": "Implementation and explanation",
  "automatic": {
    "runner_id": "python-tests",
    "runner_version": "1",
    "grader_file_id": "grader-upload-id",
    "check_groups": ["correctness", "edge-cases"],
    "parameters": {}
  },
  "agent": {
    "provider_id": "approved-local-provider",
    "model_id": "approved-model",
    "instructions": "Evaluate the explanation using the rubric and cite relevant passages.",
    "context_material_ids": ["guidelines-material-id"],
    "allowed_check_groups": ["correctness", "edge-cases"],
    "allow_external_processing": false,
    "limits": {"wall_seconds": 300, "max_tool_calls": 40, "max_tokens": 20000, "max_cost": "0.00"}
  },
  "criterion_policies": [
    {"criterion_id": "correctness", "evaluator": "automatic"},
    {"criterion_id": "explanation", "evaluator": "agent"}
  ],
  "overall_policy": null,
  "execution_limits": {"wall_seconds": 120, "memory_mib": 512, "cpu_seconds": 60, "output_bytes": 1048576},
  "input_requirements": [{"name": "source", "min_files": 1, "max_files": 100, "content_kind": "any"}],
  "run_budget": {"max_attempts": 3, "max_check_requests": 4, "max_concurrent_checks": 1, "total_cpu_seconds": 240, "total_output_bytes": 4194304}
}
```

Registry IDs and limits must exist/be permitted in the deployment. The JSON above is a contract example, not an assertion that those adapters/models are installed.

### Run and review

- `GET|POST /labs/{lab}/grading/runs`: list / queue one exact target. Filters: team, exercise, submission, state; normal pagination.
- `GET /labs/{lab}/grading/runs/{run}`: snapshots, state, attempt/task summaries, proposals and progress.
- `POST .../{run}/cancel`: request cancellation with current run revision.
- `POST .../{run}/retry`: explicitly retry a terminal failed/cancelled run with current revision. It preserves frozen inputs; changed policy/submission requires a new run.
- `GET .../{run}/attempts`: paged attempt history.
- `GET .../{run}/artifacts`: paged metadata; `GET .../{run}/artifacts/{artifact}/download`: inert bytes.
- `GET /labs/{lab}/grading/proposals`: review queue; filters team/exercise/state/stale.
- `GET .../proposals/{proposal}`: candidate, rationale/evidence, current assessment and eligibility.
- `POST .../proposals/{proposal}/accept`: apply proposal or complete operator replacement as draft/final under explicit CAS preconditions.
- `POST .../proposals/{proposal}/reject`: retain candidate and record rejection reason.

Run creation requires `team_id`, `exercise_id`, `submission_id`, explicit named input bindings, mode, expected rubric revision and expected active plan ID. It snapshots the actual assessment ID/revision and slot generation at enqueue. A new run is an intentional regrade; it does not overwrite another run, proposal or current assessment.

Acceptance requires proposal revision, the current assessment ID/revision and slot generation displayed during review, current rubric revision and current active plan ID. Each team/exercise slot retains a generation outside the deletable assessment row; creating/removing an assessment identity advances it, including absent→created→deleted transitions. Existing migrated identities start with explicit generation zero, not invented historical provenance. A changed identity/generation returns `assessment_slot_changed` and requires a new run; no acknowledgement overrides a deleted/recreated slot. If only the same assessment's revision changed since enqueue, `acknowledge_assessment_change:true` additionally records deliberate replacement. The caller supplies full notes/source-independent feedback semantics; no implicit dropping of existing notes.

`use_proposal` accepts only complete scores for finalization. `replace_scores` supplies the complete criterion map or whole-exercise score, including explicit zeroes; it does not ambiguously merge partial maps. A partial proposal can be saved as draft or completed by the operator. The server recalculates totals, writes assessment + history + decision atomically, and marks the proposal accepted. No worker/MCP capability can invoke acceptance.

Stale rubric/plan, missing submission, changed assessment/proposal revision, incompatible scoring or terminal proposal decisions return structured conflicts. There is no override that certifies an old rubric as the new one; run again with the approved rules. Other pending proposals for the same target are not silently deleted; an accepted competing proposal makes them require explicit comparison/acknowledgement.

## 5. Lifecycle, leases and retries

Run states: `queued -> running -> succeeded|failed`; queued cancellation ends `cancelled`; active cancellation uses `cancelling -> cancelled`. Attempt/task states mirror execution. `succeeded` means evaluation completed, not final marks approved.

A worker claims an eligible task in a short write transaction. Each task claim creates a fresh fence/random lease ID within the selected run attempt and returns a signed lease token; claiming another task does not create another attempt. Persist non-secret claims and reconstruct the same token for a live claim replay, without renewing the lease. The worker lease token signs the lease ID/fence/worker, not a fixed expiry; the authoritative expiry lives in the lease row and heartbeats update that row. Agent grants additionally have a fixed short expiry and are replaced by the supervisor before expiry if still authorized. Tokens never appear in URLs, logs, artifacts or model context. Heartbeats use `X-Grading-Lease` and extend only the still-current lease, within configured wall-time limits. Initial lease duration: 60 seconds, heartbeat every 15 seconds; deployment ceilings can tighten these values.

Worker endpoints:
- `POST /grading/worker/tasks/claim`: supported task kinds/registry entries; one task or 204.
- `GET /grading/worker/tasks/{task}/context`: frozen task context, permitted inputs and cancellation state.
- `POST .../{task}/heartbeat`: lease renewal/progress, bounded human-readable stage text; server state is authoritative.
- `POST .../{task}/artifacts`: bounded multipart inert artifact upload.
- `POST .../{task}/complete`: typed automatic result or staged agent-evaluation ID plus runtime provenance.
- `POST .../{task}/fail`: categorized execution failure; server validates retry classification.
- `POST .../{task}/agent-session`: mint a short-lived run/attempt/task-bound agent capability, replacing any previous active session for that task.
- `GET /grading/worker/cleanup-tasks`: discover only this registered worker's tasks needing process teardown, including expired claims after restart.
- `POST .../{task}/cleanup`: acknowledge termination for its original claim/fence. This narrowly scoped acknowledgement may follow lease expiry; it cannot upload results, renew execution or publish a proposal.

A stale/expired fence cannot upload, renew, complete, publish a proposal or resurrect deleted work. Lease expiry revokes associated agent capabilities, marks the task/attempt failed with `worker_lost`, and requires explicit retry. No automatic whole-run retry is enabled initially, because model calls and execution can have cost or nondeterministic effects. The dispatcher can reclaim unstarted queued work; it cannot run an expired active task as the same attempt.

External execution is at-least-once, not exactly-once. Result publication is fenced and deduplicated. The worker terminates its isolated process tree if heartbeat authorization is lost or cancellation is observed. A completed task acknowledgement may be replayed but never creates another proposal.

Cancellation is idempotent. Queued tasks become cancelled immediately. Running tasks stay cancelling until the supervisor acknowledges process termination or their lease expires; no result can be accepted after cancellation has committed. Expiry may yield a fenced terminal run with `cleanup_uncertain:true`, not proof that its old sandbox stopped. Registered workers can later acknowledge the original fence through the cleanup-only endpoint. Retry and destructive deletion remain blocked until cleanup is confirmed; a worker restart first reconciles its cleanup-task list. Operator UI exposes this uncertainty instead of pretending cancellation proves every process has stopped.

Agent and automatic slots are distinct. An agent can wait for a requested check while an automatic slot claims it. A deployment without an available automatic slot rejects on-demand checks as unavailable instead of deadlocking indefinitely. Every dynamic check shares the original run/attempt snapshots and budgets. Equivalent check-group requests in the same attempt return the existing task even with different idempotency keys; a check cannot spawn checks. Atomically reserve total count, concurrent slots, worst-case CPU and output before dispatch. Failed tasks and expired leases consume their reservations conservatively; retries never reset run budgets. Agent token/tool/cost/time budgets are cumulative across attempts as well. Retry is explicit, requires confirmed cleanup and remaining budget, and never adopts old attempt results implicitly.

## 6. Idempotency and errors

Existing catalog POSTs remain non-idempotent and continue rejecting unsupported `Idempotency-Key`. New grading command endpoints explicitly require that header (claim/heartbeat are exceptions described below).

Keys must be opaque UUIDv4 values, not names/student identifiers; preserve accepted strings exactly. Scope keys by authenticated principal, operation and owning resource. Store canonical validated request hashes and durable receipts in the same transaction as the command. Same key/body replays the original receipt; same key/different body returns `409 idempotency_conflict`. Changing keys intentionally creates another run/plan/decision request; the platform does not promise automatic deduplication across different keys.

Receipts remain as long as their owning record. On confirmed deletion, retain a minimal non-sensitive key tombstone with no student content; replay returns `410 resource_deleted` and cannot recreate the target. Authentication/scope checks occur before replay lookup. Retention and administrative purge are deployment policy; expired keys do not silently become reusable for the original deleted resource.

Claims are not blindly retried after an uncertain response: worker claim includes a unique `claim_id`, and a repeated claim ID returns the same live lease/task without renewal, not a second task; an expired claim ID conflicts and a new claim ID is required. Heartbeats are naturally repeatable and do not require a key. Completion receipts can replay the original committed outcome for the same principal/task/original fence, even after that lease became terminal; they authorize no new work.

Agent-session receipts store non-secret grant metadata. A signed capability can be reconstructed for a replay while its grant is live; no plaintext bearer token is stored in results or receipts. Expired grants require a new request/key. The signing key stays private to the API; workers never forward worker credentials to the model.

A replay returns the historical committed receipt, not a claim about today's current grade/run state; clients refresh current GET views before reconciliation. Failed precondition requests do not consume a successful idempotency receipt.

Use existing `{code,message,details}` error shape. Add explicit codes for grading conflicts/unavailability, stale leases, stale plans/proposals, missing inputs, invalid evaluations, privacy rejection, cancellation and deleted resources. 401 is authentication; 403 is insufficient capability; 404 hides other-owner resources; 409 is state/precondition conflict; 410 is deleted receipt target; 413/422 retain existing bound/validation meanings; 503 means required execution capacity/policy unavailable. Failed execution is represented in a run, not by an HTTP request held open until grading finishes.

Normative grading codes: `grading_plan_incompatible`, `rubric_conflict`, `assessment_conflict`, `assessment_slot_changed`, `proposal_decided`, `stale_proposal`, `lease_expired`, `stale_fence`, `active_grading`, `execution_cleanup_pending`, `budget_exceeded`, `invalid_evaluation` and `idempotency_conflict` use409; `privacy_policy_denied` uses403; `execution_unavailable` uses503; `resource_deleted` uses410. Wrong-owner resources return404 before exposing details. Validation of malformed bodies/unknown fields uses422. Completion/cancellation races are resolved by whichever transition commits first.

## 7. Security, sandbox and provider policy

Authority is intentionally narrow, not a speculative multi-user system:
- Existing **operator** authority configures/activates plans, starts/cancels/retries runs, reads private results, approves grades and performs deletion.
- Registered **worker** credentials are separately issued/revoked by operator administration outside ordinary student/catalog APIs. They are scoped by lab, task kind and registry IDs. Store token digests; never distribute the operator key to workers. Operator administration uses the same application service through a future local administrative CLI, not ad-hoc database edits. Principal IDs identify credentials/authority, not verified individual humans under today's shared operator key.
- **Agent-session** capabilities bind one live task/attempt, allowed context inputs and check groups. They cannot access arbitrary catalog endpoints, other runs/teams, acceptance, plan edits or deletion.

Host/Origin and cookie defenses continue unchanged. Remote worker/MCP credentials require an encrypted transport; same-host execution can use a local transport. Worker/agent signing uses purpose-separated API-managed keys and never treats a capability token alone as a worker credential. Authorization is enforced by service/API checks for every tool/route; hiding a tool is not a security boundary. All privileged catalog routes must reject worker/agent credentials unless specifically granted; introducing a role label without enforcement is insufficient.

Execution policy:
- Read-only pinned input mounts; separate disposable writable workspace; no catalog DB, production blob-root mount, credentials, Docker socket, privileged mode or general host paths.
- Non-root execution, dropped capabilities, process/resource/output limits and deny-by-default network.
- Trusted supervision is outside the student execution boundary. Student stdout/JSON does not become trusted test results or tool instructions. Keep reference solutions out of student sandboxes; trusted check harnesses should communicate with student programs over bounded channels.
- Approved sandbox runtime IDs resolve to immutable environment/image digests. A rootless hardened container is a practical baseline, not a claim of VM-grade isolation; deployments handling deliberately adversarial code should use a stronger VM boundary. No dynamic client-selected images or packages fetched at runtime.
- Student files, comments, reports and logs remain untrusted data for the agent. Tool permission/budget checks are external to the LLM; no unrestricted terminal/browser/network tools.
- Agent provider egress is restricted to configured endpoints. No student-program network simply because a model provider requires network access.
- Runtime failure, malformed grader output, provider failure, cancellation or worker loss is not a zero. A student compile/test timeout may affect points only when an approved rubric rule explicitly says so.

External model processing defaults off. Both deployment policy and explicit active-plan approval must allow it. Strip team members/labels from agent context; use opaque IDs and alias original filenames/member paths in agent file listings and normalized logs. Original paths remain available only to authorized operator/worker execution contexts. Revoking a deployment provider/privacy permission revokes affected sessions and blocks further disclosure even for previously approved plans. File contents can still contain personal data, so this is minimization, not guaranteed anonymization. Operators must inspect/authorize what the provider receives. Provider keys are referenced local secrets, never stored in plans/OpenAPI examples/results. Store model/provider version, observable tool events, token/cost usage where available and prompt-template hash; do not claim model reasoning is reproducible or a numeric self-confidence is calibrated accuracy.

## 8. Deletion, retention and export

The existing confirmed cascade must include plans, runs, attempts/tasks, artifacts, staged evaluations, proposals and decisions as appropriate. Extend impact count kinds and fingerprint inputs. No foreign-key blocker may be introduced without a visible scoped explanation.

Lab/team/exercise/submission deletion selects their corresponding grading records. Assessment deletion deliberately clears all grading runs/proposals/decisions for that team/exercise slot together with its current grade/history, advances the persistent slot generation, and preserves independent evidence, submission versions and the exercise plan. These associated execution records appear in the confirmation counts. This clean-reset choice prevents hidden proposals from repopulating a deliberately cleared grade. Deleting a run includes its attempts/tasks/artifacts/proposals/decisions and any assessment whose current/history origin references it; this destructive consequence must appear in impact preview. Because the affected assessment slot is cleared, other grading runs for that same slot may also enter the closure; preview must show the complete fixed-point closure, not just the selected run. Deleting a plan requires no active binding and removes dependent runs and their induced assessment closure only with explicit cascade confirmation.

Pinned grading-input files are references. Deleting/replacing a material association alone does not rewrite a plan or invalidate its copied snapshot; explicit file deletion must include dependent plans/runs and induced grade/history closure, or fail scoped-safe when surviving references cannot be removed. When file-level cascade removes an active plan while retaining its exercise, it clears the binding and increments that exercise/rubric revision atomically. Deletion preview lists these retained-exercise updates separately from removed-record counts and fingerprints their current revisions. Shared file bytes/backups are retained under the same current policy.

A destructive plan involving queued/running/cancelling work returns `409 active_grading` with the owned run IDs. The operator cancels and waits, then obtains a fresh preview/confirmation. Do not perform out-of-transaction execution teardown inside SQLite deletion or silently retry with a changed token. Queued/running/cancelling work and terminal work with unconfirmed cleanup block deletion. The latter returns `409 execution_cleanup_pending`, even after its lease expired. Outstanding grants are revoked in the final delete transaction. Late callbacks fail fenced and cannot recreate rows.

Add deletion-impact/DELETE routes for grading plans, runs and proposals, using the same token/revision protocol. Proposal deletion is permitted only when it has no accepted assessment/history references; deleting an accepted proposal requires the containing run cascade so its grade consequences are explicit. Run/proposal/artifact bytes remain private immutable content; this is catalog deletion, not secure erasure.

Lab export includes definitions, snapshots, run/attempt/task metadata, proposals, decisions and artifact references. Never export bearer/lease tokens, provider secrets or private model reasoning. Full backup includes grading metadata/private artifact content and the necessary auth/config state; execution environments are referenced by digest, not reconstructed from student uploads.

## 9. Agent API and MCP mapping

The agent capability determines the current task, so the client cannot choose another run ID:

- `GET /grading/agent/context` -> `get_grading_context`: frozen rubric, approved instructions/input manifest and permitted check groups; no student membership/worker credential.
- `GET /grading/agent/files` -> `list_submission_files`: paged allowed inputs only, with stable input IDs and safe paths.
- `GET /grading/agent/files/{input}/text` -> `read_submission_file`: bounded line-range text; binary/unsupported content gives a structured refusal.
- `POST /grading/agent/checks` -> `request_test_run`: approved group only, idempotent and budgeted; creates an automatic task in the same attempt.
- `GET /grading/agent/checks/{task}` -> `get_run_results`: scoped state/results/artifact references.
- `GET /grading/agent/artifacts/{artifact}/text` -> `read_run_log`: allowed bounded normalized text, never arbitrary paths.
- `POST /grading/agent/evaluations` -> `submit_grade_proposal`: stages one validated agent evaluation for the current task. It cannot finalize a grade or supply automatic/human-owned scores.

Staged evaluation creation does not itself complete the worker task. The supervisor completes the agent task with that evaluation ID and execution provenance. Only a valid current lease can cause proposal assembly. Terminal attempt failure/cancellation cancels its queued child checks, fences any running children, and requires confirmed cleanup before retry. A second different staged evaluation for the same task conflicts; explicit replay returns the same ID. If a task/attempt fails, its staged record remains diagnostic and is not a normal proposal.

MCP uses these typed operations directly. UI review continues to use public operator endpoints. Missing provider/runner support is not hidden behind tool names, and MCP availability does not imply sandbox readiness.

## 10. UI and initial release scope

- Exercise Grading setup: immutable plan editor/version list, readable active binding, execution/privacy approval and compatibility warnings.
- Team/exercise workspace: explicit submission selector; automatic/agentic/hybrid run actions enabled according to active plan/capabilities.
- Run view: real queue/task state, progress, cancellation, categorized failures, logs/artifacts, snapshots and rerun history.
- Review view: proposal/current-grade comparison, criterion evidence, unresolved criteria and stale/version warnings; accept, complete/edit-and-accept, save draft or reject.
- Lab queue: filtered runs and pending proposals. Bulk enqueue can initially submit bounded individual requests; a dedicated batch object/API, auto-selected latest submissions and auto-finalization are not included.

A run cannot make an ungraded row appear completed. The existing overview continues to count only approved current-rubric final assessments. Do not generate grades or migrate historical Lab1 analyses as part of this feature.

## 11. Implementation acceptance gates after approval

These are future implementation requirements, not claims of tests already passing:

1. Schema migrations preserve current catalog rows, exact scores, history and private bytes.
2. Plan activation/version changes and partial/manual/criterion scoring use exact semantics and reject wrong IDs/owners.
3. Enqueue snapshots are coherent under concurrent rubric/material/submission changes; idempotency replay never creates duplicate work.
4. Concurrent claims have one winner; stale fences, heartbeat loss, duplicate/out-of-order completion and uncertain responses cannot publish twice.
5. Cancel/delete/completion races have transactional outcomes with zero resurrection and honest teardown state.
6. Malformed grader/agent output, missing evidence, external-processing rejection and provider/worker failures never fabricate zeroes or final grades.
7. Proposal acceptance checks all displayed revisions/policy snapshots, preserves notes intentionally, and atomically writes history/decision.
8. Worker/agent credentials cannot reach operator catalog writes, other teams, hidden materials, acceptance or deletion; student prompt injection cannot expand tools.
9. Sandbox tests cover filesystem, process, resource, output and egress restrictions with real isolated execution.
10. MCP and direct API tests exercise the same rules; UI browser tests verify full review flow, cancellation, mobile state and preserved drafts.

## 12. Explicit approval decisions

This proposal recommends: required human review; immutable per-exercise plans and explicit activation; one primary evaluator per criterion; run-as-job with fenced attempts/tasks; SQLite coordination; separate worker/agent authorization; deny-by-default external model processing; bounded on-demand check tasks; and cancel-before-delete for active work.

The user may change any of these before implementation. No code or deployment begins until the corrected, approved design is supplied. The OpenAPI companion is the concrete proposed wire contract, not a description of currently served routes.
