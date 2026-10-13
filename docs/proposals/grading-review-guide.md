# Grading proposal — review guide

**Final proposed contract v1; awaiting your corrections and approval. Nothing here is implemented or deployed.**

Read this guide for the decisions and endpoint inventory, `grading-design.md` for full behavior/rationale, and `grading-api.openapi.json` for exact request/response schemas and security requirements. `grading-api.validation.json` records actual structure/schema checks, not runtime grading tests.

## Decisions to approve or change

1. **Human review required:** automatic/agentic/hybrid runs never directly finalize marks.
2. **One scoring owner per criterion:** automatic, agent or human. Hybrid combines owners; it does not average competing grades. Existing manual/criteria scoring remains unchanged.
3. **Immutable plans + explicit activation:** execution/model/test/input policy is versioned per exercise. A different activated plan stales earlier grades; creating an inactive version does not.
4. **Explicit submission and file mapping:** select an exact version and bind named logical inputs to exact safe archive member paths. No newest/best inference or filename-based membership.
5. **One run is the job:** frozen inputs, execution attempts, bounded automatic/agent tasks, artifacts and separate review proposals. SQLite coordination first, separate supervised execution slots, no Redis requirement.
6. **No execution in the web server:** approved adapter IDs resolve pinned runtimes. Grader uploads alone never authorize execution. Student execution has no production mounts, secrets, arbitrary network or commands selected by the agent.
7. **Three credential boundaries:** operator; registered scoped worker; live task-bound agent capability. MCP is a thin adapter and cannot approve grades or delete records.
8. **Cloud disclosure off by default:** operator and deployment permission needed; pseudonymous context does not guarantee anonymous file contents.
9. **Explicit retries, cumulative budgets:** lost workers/failures do not manufacture zeroes. Retrying creates another attempt but does not reset cost/check/output budgets or reuse old results implicitly.
10. **Transactional review:** accept with current assessment identity/revision/slot generation and policy/proposal preconditions. A deleted/recreated grade requires a new run; merely fetching fresh revisions is not authorization to revive it.
11. **Honest cancellation/cleanup:** stale leases fence writes but do not prove process death. Cleanup acknowledgements are separate; uncertain teardown blocks retry/deletion.
12. **Clean-reset deletion:** deleting an assessment clears its associated grading runs/proposals/decisions as well as grade/history, but preserves independent evidence/submission versions. Removing accepted provenance can therefore induce the complete assessment-slot closure. Every effect must be previewed and confirmed.

The clean-reset policy in item 12 and required-review policy in item 1 are deliberate proposed product choices, not technical inevitabilities. They are especially worth reviewing.

## Wire conventions

- All paths below are relative to `/api/v1`; these are new proposed routes, not currently available endpoints.
- Points/costs are decimal strings. Unknown is null; zero must be explicit.
- Collection reads use `{items,total,limit,offset}`, limit 1–200.
- Strict bodies reject unknown fields. Runtime parameter objects additionally use the registered adapter's JSON schema.
- Operator cookies keep exact Origin checks. Worker/agent routes require their distinct credentials, never the full operator token in model/sandbox context.
- Grading mutations require an opaque UUIDv4 `Idempotency-Key`, except claim (deduplicated `claim_id`) and repeatable heartbeat. Existing catalog POST retry semantics do not change.
- Worker execution routes require `X-Grading-Lease`; cleanup uses original worker/claim/fence and remains narrowly permitted after lease expiry.
- Lease/agent/worker secrets never belong in URLs, logs, student mounts, artifacts or the grading proposal.
- Acceptance and deletion are single transactions; external program execution is not exactly-once.

## Operator / UI API

- `GET /grading/capabilities` — `getGradingCapabilities`
- `GET /labs/{lab_id}/exercises/{exercise_id}/grading-plans` — `listGradingPlans`
- `POST /labs/{lab_id}/exercises/{exercise_id}/grading-plans` — `createGradingPlan`
- `GET /labs/{lab_id}/exercises/{exercise_id}/grading-plans/{plan_id}` — `getGradingPlan`
- `DELETE /labs/{lab_id}/exercises/{exercise_id}/grading-plans/{plan_id}` — `deleteGradingPlan`
- `GET /labs/{lab_id}/exercises/{exercise_id}/grading-plan` — `getActiveGradingPlan`
- `PUT /labs/{lab_id}/exercises/{exercise_id}/grading-plan` — `bindGradingPlan`
- `GET /labs/{lab_id}/grading/runs` — `listGradingRuns`
- `POST /labs/{lab_id}/grading/runs` — `createGradingRun`
- `GET /labs/{lab_id}/grading/runs/{run_id}` — `getGradingRun`
- `DELETE /labs/{lab_id}/grading/runs/{run_id}` — `deleteGradingRun`
- `POST /labs/{lab_id}/grading/runs/{run_id}/cancel` — `cancelGradingRun`
- `POST /labs/{lab_id}/grading/runs/{run_id}/retry` — `retryGradingRun`
- `GET /labs/{lab_id}/grading/runs/{run_id}/attempts` — `listGradingAttempts`
- `GET /labs/{lab_id}/grading/runs/{run_id}/artifacts` — `listGradingArtifacts`
- `GET /labs/{lab_id}/grading/runs/{run_id}/artifacts/{artifact_id}/download` — `downloadGradingArtifact`
- `GET /labs/{lab_id}/grading/proposals` — `listGradeProposals`
- `GET /labs/{lab_id}/grading/proposals/{proposal_id}` — `getGradeProposal`
- `DELETE /labs/{lab_id}/grading/proposals/{proposal_id}` — `deleteGradeProposal`
- `POST /labs/{lab_id}/grading/proposals/{proposal_id}/accept` — `acceptGradeProposal`
- `POST /labs/{lab_id}/grading/proposals/{proposal_id}/reject` — `rejectGradeProposal`
- `GET /labs/{lab_id}/exercises/{exercise_id}/grading-plans/{plan_id}/deletion-impact` — `getGradingPlanDeletionImpact`
- `GET /labs/{lab_id}/grading/runs/{run_id}/deletion-impact` — `getGradingRunDeletionImpact`
- `GET /labs/{lab_id}/grading/proposals/{proposal_id}/deletion-impact` — `getGradeProposalDeletionImpact`

## Worker supervisor API

- `POST /grading/worker/tasks/claim` — `claimGradingTask`
- `GET /grading/worker/tasks/{task_id}/context` — `getWorkerTaskContext`
- `GET /grading/worker/tasks/{task_id}/inputs/{input_id}/download` — `downloadWorkerInput`
- `POST /grading/worker/tasks/{task_id}/heartbeat` — `heartbeatGradingTask`
- `POST /grading/worker/tasks/{task_id}/artifacts` — `uploadTaskArtifact`
- `POST /grading/worker/tasks/{task_id}/complete` — `completeGradingTask`
- `POST /grading/worker/tasks/{task_id}/fail` — `failGradingTask`
- `POST /grading/worker/tasks/{task_id}/agent-session` — `createAgentSession`
- `GET /grading/worker/cleanup-tasks` — `listWorkerCleanupTasks`
- `POST /grading/worker/tasks/{task_id}/cleanup` — `acknowledgeTaskCleanup`

## Agent / MCP API

- `GET /grading/agent/context` — `getAgentGradingContext`
- `GET /grading/agent/files` — `listAgentInputFiles`
- `GET /grading/agent/files/{input_id}/text` — `readAgentInputText`
- `POST /grading/agent/checks` — `requestAgentCheck`
- `GET /grading/agent/checks/{task_id}` — `getAgentCheckResults`
- `GET /grading/agent/artifacts/{artifact_id}/text` — `readAgentArtifactText`
- `POST /grading/agent/evaluations` — `stageAgentEvaluation`

## Example: queue a hybrid evaluation

This is an illustrative request, not a live run or seed record. IDs must be obtained from the real catalog/plan after implementation.

```json
{
  "team_id": "team-id",
  "exercise_id": "exercise-id",
  "submission_id": "submission-id",
  "mode": "hybrid",
  "rubric_revision": 5,
  "grading_plan_id": "plan-id",
  "input_bindings": [
    {"name": "source", "member_paths": ["team-folder/main.s"]}
  ]
}
```

Send to `POST /labs/{lab_id}/grading/runs` with an operator credential and UUIDv4 idempotency key. It returns202 and a run ID; poll the run, then review its proposal. It does not modify the assessment.

## Example: accept the reviewed proposal as final

```json
{
  "revision": 1,
  "assessment_id": null,
  "assessment_revision": 0,
  "assessment_slot_generation": 0,
  "rubric_revision": 5,
  "grading_plan_id": "plan-id",
  "acknowledge_assessment_change": false,
  "status": "final",
  "scores": {"kind": "proposal"},
  "notes": "Reviewed against the selected submission and rubric."
}
```

Send to `POST /labs/{lab_id}/grading/proposals/{proposal_id}/accept`. Preconditions are the values actually displayed during review. To edit before accepting, use a complete `scores` replacement: `{kind:"criteria",criterion_scores:{...}}` or `{kind:"overall",score:"..."}`. Notes are explicit full replacement; do not accidentally discard existing notes. Only complete valid scores can finalize.

## Validation boundary

The companion OpenAPI is structurally validated and its internal references/request examples are checked. This is not an implemented server, sandbox certification or a claim that concurrency/authorization tests passed. The detailed design lists the runtime acceptance gates required after approval.

**Next step:** return your corrections or the approved design. Implementation remains blocked until then. No application source, production data, deployment, commit or push was changed for this proposal.
