# Lab1 isolated execution evidence

`tools/lab1_grader.py` collects function-level RISC-V evidence using the operator-selected, trusted Lab1 grader. It does not assign marks, execute assembly on the host, repair student code or choose function labels automatically.

## Toolchain

The runner verifies the jar hash and pins a Linux ARM64-compatible Docker image:

- RARS 1.6: `https://github.com/TheThirdOne/rars/releases/download/v1.6/rars1_6.jar`
- RARS SHA256: `780f730eb457b1ba609e968accc2c8b77d8f92c3d9dbf30cc7fdb3cfb14e8c24`
- Docker image: `eclipse-temurin@sha256:207ecae0b2b104dfc6dfa763d1e9cd2041cb344800a180e24cb1a28ed533ff90`

```bash
mkdir -p workspace/toolchain
curl -fL https://github.com/TheThirdOne/rars/releases/download/v1.6/rars1_6.jar \
  -o workspace/toolchain/rars1_6.jar
sha256sum workspace/toolchain/rars1_6.jar
docker pull eclipse-temurin@sha256:207ecae0b2b104dfc6dfa763d1e9cd2041cb344800a180e24cb1a28ed533ff90
```

The image is pinned to the verified ARM64 toolchain. Other host architectures need a separately validated compatible image/runner configuration, not an unverified replacement.

## Explicit source mapping

Import the lab first and get a version ID and exact member path from the inventory/dashboard. Read the source to confirm the intended case-sensitive entry label and argument/return convention. A filename alone is not enough.

```bash
.venv/bin/python tools/lab1_grader.py \
  --file workspace/labs/Lab1/submissions/VERSION_ID/member.asm \
  --ex bs --func BinarySearch \
  --grader Lab1/grade.py --rars workspace/toolchain/rars1_6.jar \
  --output workspace/bs-run.json

.venv/bin/python -m ece218 run-import Lab1 VERSION_ID workspace/bs-run.json \
  --source member.asm
.venv/bin/python -m ece218 prepare Lab1 --version VERSION_ID
```

Replace `VERSION_ID`, `member.asm` and `BinarySearch` with exact inspected values. For substring use `--ex substr` and its exact entry label. The default adapter passes inputs in `a0,a1,a2`, reads the answer from `a0` and uses the standard callable harness.

`--regs`, `--ret` and `--delim` select diagnostic adapters. Keep those results separate from default callable evidence: an alternative return register proving the algorithm works does not establish compliance with the assignment ABI. Inline `main` implementations may need a separately designed console adapter; a missing callable label is `adapter_error`, not a zero algorithm grade.

Exit code `0` means collection completed, **including runs with failed tests**. Exit `2` means configuration/adapter failure. The JSON retains source/includes, trusted grader, suite, adapter, jar/image hashes, exact test data, logs, duration and errors. Import output from trusted collection only; the result marker is not tamper-proof against deliberately hostile assembly.

## Execution isolation and limits

Execution uses network-disabled, read-only, nonroot Docker with dropped capabilities, seccomp, CPU/PID limits and bounded run time/output. Source/include snapshots are validated before execution. Docker access remains a privileged local prerequisite; the web app never invokes it.

On hosts where Docker's memory cgroup is unavailable, the runner verifies **512 MiB RLIMIT_DATA + 256 MiB JVM heap** fallback limits and records the missing cgroup enforcement. This is an allocation/heap bound, **not a total-RSS bound**. Do not describe it as full memory-cgroup isolation.

The trusted `--grader` Python module is loaded on the host to obtain test suites and build harnesses. Never point it at a grader uploaded by a student. Uploaded materials are not automatically executed.

## Interpretation

- Current provided suites contain 19 binary-search and 22 substring cases. Historical reports may use 19/25; never overwrite those historical counts as if reproduced by the current suite.
- Functional returns, ABI/register preservation, console output, theory and oral understanding are different assessments.
- The provided binary-search solution is inline code, not automatically a callable reference. Validate a callable adapter independently before using it as a reference.
- Theory answer/reference conflicts and simulator-specific guideline claims belong in trusted operator review context. Do not silently convert them into deductions.
- Lab exercise weights are metadata, not a test-to-mark formula. Numerical final marks require the course's actual grading policy and human approval.

## Runner tests

```bash
LAB1_RARS_JAR=workspace/toolchain/rars1_6.jar \
  .venv/bin/python -m unittest discover -s tools -p 'test_lab1_grader.py' -v
```

With the pinned jar and Docker available this runs real isolated integrations as well as synthetic unit tests. Without explicit opt-in/toolchain, integration tests are skipped rather than reported as executed.
