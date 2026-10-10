# ECE218 Lab Review Platform

A private teaching-assistant workspace for importing lab submissions, reviewing each exercise with an agent, and recording human grading decisions. The dashboard is in Greek. Every archive version remains visible; it never silently chooses the newest or best submission.

## Review workflow

```text
Lab manifest + original archives + handout/guidelines/solutions
                         ↓
              Safe import into private workspace
                         ↓
    Optional isolated tests → source-linked execution evidence
                         ↓
          Prepared bundle → tool-less agent → validated draft
                         ↓
       Team/exercise dashboard → separate human notes and grade
```

The platform keeps three distinct kinds of information:

- **Historical evidence:** previously recorded results, imported by exact archive filename and labeled with their original suite.
- **Current execution evidence:** immutable runner artifacts linked to exact source bytes, including failed inputs, expected values, returned values and errors.
- **Agent reviews and human decisions:** cited draft findings and oral questions; the instructor's notes, approval and grade are stored separately.

Exercise weights alone do not define a numerical grading policy. Without an explicit machine-readable rubric, agent reports are qualitative. Functional tests do not establish ABI compliance, console behaviour or oral understanding.

## Requirements and setup

- Python 3.11+ for the application and Lab1 runner; Node.js for frontend tests.
- Optional `pypdf` for PDF extraction. Without it the application can use installed `pdftotext`.
- RAR intake needs a full `7zz`/`7z` installation with RAR decoding support. Some distribution builds can list RAR files but cannot decode them.
- Lab1 execution requires Docker and the pinned RARS/image described in [the Lab1 runner guide](docs/lab1-runner.md).
- Agent review requires an installed, configured Hermes runtime or another explicitly selected JSON reviewer.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
make test PYTHON=.venv/bin/python
```

The backend and browser UI need no build step or JavaScript dependencies.

## Add a lab

Create a local `Lab2/` directory containing submissions and trusted teaching materials. Write `Lab2/lab.json`; paths are relative to that manifest. This is an example configuration, not an existing course handout:

```json
{
  "id": "Lab2",
  "title": "Lab 2",
  "exercises": [
    {"id": "exercise1", "title": "Exercise 1"}
  ],
  "materials": [
    {"role": "handout", "path": "handout.pdf"},
    {"role": "guidelines", "path": "guidelines.txt"},
    {"role": "grader", "path": "grader.py"}
  ],
  "submissions": "submissions",
  "teams": {
    "team-example.zip": ["0012", "0034"]
  }
}
```

Material roles are `handout`, `guidelines`, `grader`, `testcases` and `solution`. The importer retains these files; **it does not execute an uploaded grader**. Only trusted, separately invoked runners may execute a grader.

An exact `teams` mapping overrides filename-derived identifiers. Leading zeros are preserved. Member order does not split a team: key generation uses unordered membership while each archive record preserves the original identifiers and order. Name-only submissions remain unresolved until mapped; duplicate archives remain separate versions even when their contents are identical.

```bash
.venv/bin/python -m ece218 import Lab2/lab.json
.venv/bin/python -m ece218 prepare Lab2
.venv/bin/python -m ece218 list
```

Re-import is additive and idempotent for unchanged archives. Changed archive bytes become a distinct version. Corrupt/unsafe archives remain blocked with their error and preserved original; they are not silently repaired.

## Run agent review

Use a **trusted** reviewer command. It receives one prepared JSON bundle on stdin and must emit one report JSON on stdout. Commands are split into arguments and executed without a shell. The dashboard cannot launch a reviewer or student code.

For the included Hermes adapter, set the paths to your installed Hermes source and its Python runtime; these are process options, not application configuration:

```bash
export HERMES_REVIEWER_ROOT="$HOME/.hermes/hermes-agent"
export HERMES_REVIEWER_PYTHON="$(hermes --print-runtime-command | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')"

.venv/bin/python -m ece218 review-run Lab2 \
  --command '.venv/bin/python tools/hermes_reviewer.py --timeout 300' \
  --timeout 330
```

Use Hermes' prepared interpreter if your installation does not bootstrap dependencies with the selected Python. The adapter resolves configured model/provider credentials through Hermes; it does not change profiles or settings. `--model` and `--provider` select per-invocation overrides. `--context-file` supplies trusted operator notes, never student instructions.

The adapter has no advertised tools and refuses tool calls, malformed reports and invalid citations. Reviews may send source content to the configured model provider: use only a provider approved for student data. Tool isolation is not an OS sandbox for the trusted Hermes installation. Failed/time-limited calls are recorded as failures, not fabricated feedback.

To review one explicit archive version, add `--version VERSION_ID`. External reports can also be checked with:

```bash
.venv/bin/python -m ece218 review-import Lab2 workspace/review.json
```

See [the data contract](docs/data-contract.md) for report shape, citations and evidence imports.

## Open the dashboard

```bash
make serve PYTHON=.venv/bin/python
# http://127.0.0.1:3458/
```

Select a lab, search by student identifier/archive, and open an explicit version to see exercise findings, source citations, documents and failures. Preparing a bundle does not run an agent. Human-note saves require a matching server readback.

For an explicitly trusted LAN, use your machine's actual address:

```bash
.venv/bin/python -m ece218 serve \
  --host 192.0.2.10 --hostLAN 192.0.2.10 --port 3458
```

`192.0.2.10` is a documentation example; replace it. The server has **no authentication**. Anyone able to reach an allowed LAN address can read student records and modify human notes. Keep it on localhost or a trusted VPN/LAN with appropriate access controls; do not expose it publicly. Host/Origin checks are not authentication.

## Export and historical import

```bash
.venv/bin/python -m ece218 report Lab2 --json workspace/lab2-report.json
.venv/bin/python -m ece218 evidence-import Lab1 workspace/historical-report.json \
  --source 'Historical lab report; original suite'
```

Historical imports use exact filenames. If one filename has multiple hash versions, provide `--versions mapping.json` with exact archive-name → version-ID pairs. Import never turns historical evidence into a fresh run or an approved grade.

## Repository layout

- `ece218/`: private inventory, safe archive intake, evidence linkage, review validation, CLI and HTTP API.
- `web/`: dependency-free dashboard and frontend tests.
- `tools/`: isolated Lab1 runner and tool-less Hermes reviewer.
- `tests/`: synthetic backend/CLI/HTTP regressions.
- `summary/`: compatible, read-only historical Lab1 dashboard; see its README.
- `docs/`: data contract and Lab1 runner instructions.
- `Lab*/`, `workspace/`, `.submission-cache/`: local teaching inputs and generated private records, excluded from Git.

Back up original lab directories, source CSVs and the private workspace separately. The code repository is not a student-data backup. Do not force-add ignored submissions, grades or credentials.

## Troubleshooting

- **Submission file absent:** inspect the archive's blocked status and original-member inventory. Moved historical paths are resolved by the legacy dashboard's verified extraction cache.
- **RAR “Unsupported Method”:** install a full decoder; archive listing alone is not proof of successful extraction.
- **CRC failure:** obtain a corrected submission as a new version. Preserve the corrupt original.
- **Unresolved team:** add an exact manifest mapping and re-import; do not guess from a student's display name.
- **Scanned PDF:** text extraction reports `OCR required`. The platform does not pretend to read image-only pages; review them manually or use a separately verified OCR workflow.
- **Stale bundle/review:** inputs or attached evidence changed. Prepare again and rerun review.
- **Adapter error:** no completed functional score exists. Inline assembly is not automatically a callable function.
- **HTTP 403:** the requested Host or mutation Origin does not match the advertised address. Use the exact dashboard URL.
