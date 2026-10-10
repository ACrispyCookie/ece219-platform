#!/usr/bin/env python3
"""Collect callable Lab1 test evidence with pinned RARS inside Docker only.

Example (explicit labels, never inferred):
  python tools/lab1_grader.py --file submissions/team/student.asm --ex bs --func BinarySearch \
      --grader Lab1/grade.py --rars workspace/toolchain/rars1_6.jar --output workspace/evidence.json

Setup once, outside the sandbox:
  curl -fL https://github.com/TheThirdOne/rars/releases/download/v1.6/rars1_6.jar -o rars1_6.jar
  docker pull eclipse-temurin@sha256:207ecae0b2b104dfc6dfa763d1e9cd2041cb344800a180e24cb1a28ed533ff90

--grader loads TRUSTED Python on the host: never point it at an uploaded grader.
Only its parser, suites and harness builder are used; its host Java runner is not.
Nondefault --regs/--ret/--delim runs are callable diagnostics, not ABI verdicts.
Exit 0 means collection completed (even with failed tests); exit 2 means setup/adapter failure.
No console grading, ABI-preservation checks, final marks or bulk auto-mapping.
The emitted result marker is not tamper-proof against intentionally hostile assembly.
On hosts without cgroup memory, a verified 512 MiB RLIMIT_DATA + 256 MiB JVM heap
cap is used; this is an allocation bound, not a total-RSS cgroup bound.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import tempfile
import time
import uuid
from typing import Any

RARS_URL = "https://github.com/TheThirdOne/rars/releases/download/v1.6/rars1_6.jar"
RARS_SHA256 = "780f730eb457b1ba609e968accc2c8b77d8f92c3d9dbf30cc7fdb3cfb14e8c24"
DOCKER_IMAGE = "eclipse-temurin@sha256:207ecae0b2b104dfc6dfa763d1e9cd2041cb344800a180e24cb1a28ed533ff90"
MAX_STEPS = 2_000_000
RESULT_TAG = "@@RESULT@@="
MAX_SOURCE_BYTES = 8 * 1024 * 1024
MAX_INCLUDE_FILES = 100
MAX_CAPTURE_CHARS = 1024 * 1024


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def canonical_hash(value):
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())


def uncomment(line):
    """Remove assembly comments, respecting quoted strings and escapes."""
    quote, escaped, out = None, False, []
    for char in line:
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char == "#":
            break
        out.append(char)
    return "".join(out)


def snapshot_source(source, target):
    """Copy only source + validated include closure, never write student files.

    Includes must be literal relative paths contained in the selected source's
    directory. Reject symlinks, cycles, missing and malformed include directives.
    This is deliberately stricter than RARS, and reports adapter errors, not fails.
    """
    source = Path(source).absolute()
    if source.is_symlink():
        raise ValueError("source symlinks are unsupported")
    root = source.parent.resolve()
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    target.chmod(0o755)
    records, visiting, visited = [], set(), set()
    total_bytes = 0

    def visit(path):
        nonlocal total_bytes
        if path.is_symlink() or any(p.is_symlink() for p in path.parents if p != root and root in p.parents):
            raise ValueError("include symlinks are unsupported")
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(root):
            raise ValueError("include escapes selected source directory")
        if resolved in visiting:
            raise ValueError("include cycle is unsupported")
        if resolved in visited:
            return
        if len(visited) + len(visiting) >= MAX_INCLUDE_FILES:
            raise ValueError("too many includes")
        metadata = resolved.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("source and includes must be regular files")
        if metadata.st_size > MAX_SOURCE_BYTES:
            raise ValueError("source size limit exceeded")
        data = resolved.read_bytes()
        total_bytes += len(data)
        if total_bytes > MAX_SOURCE_BYTES:
            raise ValueError("source size limit exceeded")
        text = data.decode("utf-8", errors="strict")
        visiting.add(resolved)
        for raw in text.splitlines():
            code = uncomment(raw)
            # Also recognize label-prefixed directives instead of bypassing checks.
            code = re.sub(r"^(?:\s*[A-Za-z_.$][\w.$]*\s*:)*\s*", "", code)
            if not re.match(r"\.include\b", code, re.I):
                continue
            match = re.fullmatch(r'\.include\s+"([^"\\\r\n]+)"\s*', code, re.I)
            if not match:
                raise ValueError("unsupported .include syntax")
            name = Path(match.group(1))
            if name.is_absolute() or ".." in name.parts:
                raise ValueError("absolute or outside .include is unsupported")
            try:
                visit(resolved.parent / name)
            except OSError as exc:
                raise ValueError(f"include unavailable: {name}: {exc}") from exc
        rel = resolved.relative_to(root)
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        for directory in dest.parents:
            if directory == target or target in directory.parents:
                directory.chmod(0o755)
        dest.write_bytes(data)
        dest.chmod(0o644)
        records.append(dict(path=str(rel), sha256=sha256(data), bytes=len(data)))
        visiting.remove(resolved)
        visited.add(resolved)

    visit(source)
    return sorted(records, key=lambda r: r["path"])


def docker_command(directory, jar, harness, name):
    directory, jar = Path(directory).resolve(), Path(jar).resolve()
    if any("," in str(p) for p in (directory, jar)):
        raise ValueError("Docker mount paths containing commas are unsupported")
    if Path(harness).name != harness:
        raise ValueError("harness must be a basename")
    return ["docker", "run", "--rm", "--name", name, "--pull", "never",
            "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--user", "65534:65534",
            "--pids-limit", "64", "--memory", "512m", "--memory-swap", "512m",
            "--cpus", "1", "--ulimit", "nofile=128:128", "--log-driver", "none",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
            "--mount", f"type=bind,src={directory},dst=/source,readonly",
            "--mount", f"type=bind,src={jar},dst=/rars.jar,readonly",
            "--workdir", "/source", "--env", "HOME=/tmp", "--entrypoint", "/bin/sh",
            DOCKER_IMAGE, "-c", 'ulimit -d 524288 || exit 124; exec "$@"',
            "lab1-limit", "java", "-Xmx256m", "-XX:+UseSerialGC", "-Xss512k",
            "-XX:CompressedClassSpaceSize=32m", "-XX:MaxMetaspaceSize=96m",
            "-XX:ReservedCodeCacheSize=32m", "-Djava.awt.headless=true",
            "-Djava.io.tmpdir=/tmp", "-Djava.util.prefs.userRoot=/tmp/prefs",
            "-jar", "/rars.jar", "nc", "me", "ae2", "se3", str(MAX_STEPS),
            f"/source/{harness}"]


def inspect_image():
    """Resolve and record the pinned manifest digest + local architecture/image ID."""
    p = subprocess.run(["docker", "image", "inspect", DOCKER_IMAGE], capture_output=True,
                       text=True, timeout=20, check=True)
    image = json.loads(p.stdout)[0]
    digest = DOCKER_IMAGE.split("@", 1)[1]
    if not any(d.endswith("@" + digest) for d in image.get("RepoDigests", [])):
        raise ValueError("Docker image digest not verified")
    return dict(digest=DOCKER_IMAGE, repo_digests=image["RepoDigests"],
                id=image["Id"], architecture=image["Architecture"], os=image["Os"])


def as_text(value):
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value or ""


def limited_process(cmd, timeout) -> dict[str, Any]:
    """Bound both pipe buffers during execution; never accumulate unbounded output."""
    start = time.monotonic()
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    error = None
    try:
        with subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE) as proc, selectors.DefaultSelector() as selector:
            assert proc.stdout is not None and proc.stderr is not None
            for stream, name in ((proc.stdout, "stdout"), (proc.stderr, "stderr")):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
            while selector.get_map() or proc.poll() is None:
                remaining = timeout - (time.monotonic() - start)
                if remaining <= 0:
                    error = "timeout"
                    break
                for key, _ in selector.select(min(remaining, 0.1)):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    buffer = buffers[key.data]
                    available = MAX_CAPTURE_CHARS - len(buffer)
                    buffer.extend(chunk[:available])
                    if len(chunk) > available:
                        error = "output limit exceeded"
                        break
                if error:
                    break
            if error:
                proc.kill()
            proc.wait(timeout=5)
            rc = None if error else proc.returncode
    except OSError as exc:
        return dict(stdout="", stderr=str(exc), returncode=None, error="container unavailable",
                    duration=round(time.monotonic()-start, 6))
    return dict(stdout=as_text(bytes(buffers["stdout"])), stderr=as_text(bytes(buffers["stderr"])),
                returncode=rc, error=error, duration=round(time.monotonic()-start, 6))


def run_container(directory, jar, harness, timeout=20):
    name = "lab1-evidence-" + uuid.uuid4().hex
    cmd = docker_command(directory, jar, harness, name)
    result = limited_process(cmd, timeout)
    if result["error"]:
        try:
            subprocess.run(["docker", "rm", "--force", name], capture_output=True,
                           text=True, timeout=10)
        except (OSError, subprocess.SubprocessError) as cleanup:
            result["cleanup_error"] = str(cleanup)
    result["command"] = cmd
    return result


def probe_sandbox(directory, jar):
    """Verify effective kernel limits with trusted shell tools before student code.

    RLIMIT_DATA is set after runc's Go runtime has initialized: setting it with
    Docker --ulimit data can make runc fail before seccomp is installed on ARM64.
    No source files are executed or sourced by this fixed shell command.
    """
    name = "lab1-evidence-probe-" + uuid.uuid4().hex
    cmd = docker_command(directory, jar, "unused.asm", name)
    java_index = cmd.index("java")
    script = ('cat /proc/self/limits /proc/self/status; '
              'printf "\\n@@PIDS@@="; cat /sys/fs/cgroup/pids.max; '
              'printf "\\n@@CPU@@="; cat /sys/fs/cgroup/cpu.max')
    cmd[java_index:] = ["/bin/sh", "-c", script]
    result = limited_process(cmd, 20)
    if result["error"]:
        subprocess.run(["docker", "rm", "--force", name], capture_output=True, timeout=10)
    if result["error"] or result["returncode"] != 0:
        raise ValueError(f"sandbox probe failed: {result}")
    out = result["stdout"]
    checks = {
        "rlimit_data": bool(re.search(r"Max data size\s+536870912\s+536870912\s+bytes", out)),
        "nonroot_uid": bool(re.search(r"Uid:\s+65534\s+65534\s+65534\s+65534", out)),
        "no_new_privileges": bool(re.search(r"NoNewPrivs:\s+1", out)),
        "no_effective_capabilities": bool(re.search(r"CapEff:\s+0{16}", out)),
        "seccomp_filter": bool(re.search(r"Seccomp:\s+2", out)),
        "pids_limit": bool(re.search(r"@@PIDS@@=64\s", out)),
        "cpu_limit": bool(re.search(r"@@CPU@@=100000 100000\s", out)),
    }
    if not all(checks.values()):
        raise ValueError(f"sandbox limits not verified: {checks}; probe={out}")
    return dict(verified=True, checks=checks, **result, command=cmd)


def parse_result(result):
    if result.get("error"):
        return None, result["error"]
    rc = result["returncode"]
    if rc == 2:
        return None, "assemble error"
    if rc == 3:
        return None, "runtime error"
    if rc != 0:
        return None, f"container error (exit {rc})"
    if "maximum" in result["stderr"].lower():
        return None, "step limit hit"
    values = re.findall(re.escape(RESULT_TAG) + r"(-?\d+)(?=\s|$)", result["stdout"])
    if len(values) > 1:
        return None, "ambiguous result markers"
    if not values:
        return None, "function never returned"
    return int(values[0]), None


def collect_evidence(*, file, ex, func, grader, rars, regs="a0,a1,a2", ret="a0",
                     delim=False, timeout=20, scratch=None):
    """One explicit source/exercise/function only. No automatic label selection."""
    started = time.monotonic()
    report: dict[str, Any] = dict(schema_version=1, mode="function", exercise=ex, function=func,
                  created_at=datetime.now(timezone.utc).isoformat(), status="configuration_error",
                  adapter=dict(regs=regs, ret=ret, delim=delim), tests=[], passed=None,
                  total=None, error=None, not_evaluated=["ABI preservation", "console behaviour", "numeric final marks"])
    stage = "configuration_error"
    try:
        source, grader_path, jar = Path(file).absolute(), Path(grader).resolve(), Path(rars).resolve()
        if ex not in ("bs", "substr") or not re.fullmatch(r"[A-Za-z_.$][\w.$]*", func):
            raise ValueError("exercise and exact function label must be explicit and valid")
        if timeout <= 0 or timeout > 120:
            raise ValueError("timeout must be in (0, 120] seconds")
        jar_bytes = jar.read_bytes()
        report["jar"] = dict(path=str(jar), version="1.6", url=RARS_URL, sha256=sha256(jar_bytes), bytes=len(jar_bytes))
        if report["jar"]["sha256"] != RARS_SHA256:
            raise ValueError("RARS v1.6 SHA256 mismatch; refusing execution")
        grader_bytes = grader_path.read_bytes()
        report["grader"] = dict(path=str(grader_path), sha256=sha256(grader_bytes), trust="explicit trusted local Python")
        # importlib creates the module, but compile/exec avoids writing private __pycache__.
        spec = importlib.util.spec_from_file_location("trusted_lab1_grader", grader_path)
        if spec is None:
            raise ValueError("trusted grader must be a Python file")
        module = importlib.util.module_from_spec(spec)
        stage = "adapter_error"
        exec(compile(grader_bytes, str(grader_path), "exec"), module.__dict__)
        tests = module.BS_TESTS if ex == "bs" else module.SUBSTR_TESTS
        suite = [dict(index=i, name=t["name"], input={k:v for k,v in t.items() if k not in ("ok", "name", "input")}, display_input=t["input"], expected=sorted(t["ok"])) for i,t in enumerate(tests, 1)]
        report["suite"] = dict(sha256=canonical_hash(suite), count=len(tests), test_names=[t["name"] for t in tests])
        report["total"] = len(tests)
        parsed_regs = module.parse_regs(regs, 3, "--regs")
        parsed_ret = module.parse_regs(ret, 1, "--ret")[0]
        report["adapter"] = dict(regs=parsed_regs, ret=parsed_ret, delim=delim,
                                  classification="default_callable" if parsed_regs == ["a0", "a1", "a2"] and parsed_ret == "a0" and not delim else "callable_diagnostic")
        scratch_root = Path(scratch or os.environ.get("TMPDIR") or Path.home()/".hermes/cache/scratch")
        if scratch_root.resolve().is_relative_to(source.parent.resolve()):
            raise ValueError("scratch must be outside the selected student directory")
        scratch_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lab1-evidence-", dir=scratch_root) as tmp:
            root = Path(tmp)
            inputs = root / "source"
            files = snapshot_source(source, inputs)
            snapshot_bytes = (inputs / source.name).read_bytes()
            report["source"] = dict(path=str(source), sha256=sha256(snapshot_bytes), includes=files)
            src = snapshot_bytes.decode("utf-8")
            top, data, text, info = module.extract(src, func)
            report["adapter"]["extraction"] = info
            stage = "configuration_error"
            pinned_jar = root / "rars1_6.jar"
            pinned_jar.write_bytes(jar_bytes)
            pinned_jar.chmod(0o644)
            report["image"] = inspect_image()
            report["sandbox_probe"] = probe_sandbox(inputs, pinned_jar)
            report["limits"] = dict(timeout_seconds=timeout, max_steps=MAX_STEPS, memory="512m", cpus=1, pids=64, network="none",
                                    memory_enforcement="cgroup memory 512 MiB + RLIMIT_DATA 512 MiB + JVM heap 256 MiB")
            for case, supplied in zip(suite, tests):
                stage = "adapter_error"
                harness_name = "__evidence_" + uuid.uuid4().hex + ".asm"
                program = module.build_program(ex, supplied, func, top, data, text, delim, parsed_regs, parsed_ret)
                harness = inputs / harness_name
                harness.write_text(program, encoding="utf-8")
                harness.chmod(0o644)
                raw = run_container(inputs, pinned_jar, harness_name, timeout)
                if "memory limit capabilities" in raw["stderr"] and "Limitation discarded" in raw["stderr"]:
                    report["limits"]["memory_enforcement"] = "RLIMIT_DATA 512 MiB + JVM heap 256 MiB; cgroup memory unavailable"
                value, error = parse_result(raw)
                passed = error is None and value in supplied["ok"]
                report["tests"].append(dict(**case, **raw, harness_sha256=sha256(program.encode()), got=value,
                                             status="error" if error else "pass" if passed else "fail"))
                report["tests"][-1]["error"] = error
                harness.unlink()
        report["passed"] = sum(t["status"] == "pass" for t in report["tests"])
        report["status"] = "completed"
    except (Exception, SystemExit) as exc:
        report["status"] = stage
        report["error"] = f"{type(exc).__name__}: {exc}"
    report["duration"] = round(time.monotonic()-started, 6)
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", required=True, type=Path)
    ap.add_argument("--ex", required=True, choices=("bs", "substr"))
    ap.add_argument("--func", required=True, help="exact case-sensitive label from approved mapping")
    ap.add_argument("--grader", type=Path, default=Path("Lab1/grade.py"), help="trusted local supplied grader only")
    ap.add_argument("--rars", type=Path, required=True)
    ap.add_argument("--regs", default="a0,a1,a2")
    ap.add_argument("--ret", default="a0")
    ap.add_argument("--delim", action="store_true")
    ap.add_argument("--timeout", type=float, default=20)
    ap.add_argument("--scratch", type=Path)
    ap.add_argument("--output", type=Path, help="JSON evidence destination (default stdout)")
    args = vars(ap.parse_args(argv))
    output = args.pop("output")
    # Refuse to accidentally overwrite assembly, includes, jar or trusted grader.
    if output and (output.suffix.lower() != ".json" or output.resolve() in {args[k].resolve() for k in ("file", "grader", "rars")} or output.resolve().is_relative_to(args["file"].resolve().parent)):
        ap.error("--output must be JSON outside the selected source directory and not an input")
    report = collect_evidence(**args)
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0 if report["status"] == "completed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
