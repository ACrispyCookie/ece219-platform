"""Tests for the isolated evidence runner; no student code runs on the host.

Run: python -m unittest discover -s tools -p 'test_lab1_grader.py' -v
Optional real Docker check (uses only the independent fixture below):
LAB1_RARS_JAR=workspace/toolchain/rars1_6.jar python -m unittest discover -s tools -v
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("lab1_grader", Path(__file__).with_name("lab1_grader.py"))
assert SPEC is not None and SPEC.loader is not None
runner = importlib.util.module_from_spec(SPEC)
if Path(__file__).with_name("lab1_grader.py").exists():
    SPEC.loader.exec_module(runner)

# Independent callable test fixture, NOT the supplied inline official solution.
BINARY_SEARCH_FIXTURE = """.text
BinarySearch:
    mv t0, a0
    li t1, 0
    addi t2, a1, -1
bs_loop:
    bgt t1, t2, bs_miss
    add t3, t1, t2
    srli t3, t3, 1
    slli t4, t3, 2
    add t4, t0, t4
    lw t5, 0(t4)
    beq t5, a2, bs_hit
    blt t5, a2, bs_right
    addi t2, t3, -1
    j bs_loop
bs_right:
    addi t1, t3, 1
    j bs_loop
bs_hit:
    mv a0, t3
    ret
bs_miss:
    li a0, -1
    ret
"""

TRUSTED_FIXTURE = '''
RESULT_TAG = "@@RESULT@@="
MAX_STEPS = 2000000
BS_TESTS = [dict(name="one", input="A=[1] X=1", A=[1], X=1, ok={0})]
SUBSTR_TESTS = []
def parse_regs(text, count, opt):
    import sys
    regs = text.split(",")
    if len(regs) != count or any(r not in ["a"+str(i) for i in range(8)] for r in regs) or len(set(regs)) != count:
        sys.exit("invalid registers")
    return regs
def extract(src, func):
    import sys
    if func + ":" not in src:
        sys.exit("Function not found")
    return [], [], src.splitlines(), {"labels": [func], "warnings": []}
def build_program(ex, t, func, top, data, text, delim, regs, ret):
    return "\\n".join(text)
'''


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "source" / "student.asm"
        self.source.parent.mkdir()
        self.source.write_text(".text\nBinarySearch:\n li a0, 0\n ret\n")
        self.grader = self.root / "trusted_grade.py"
        self.grader.write_text(TRUSTED_FIXTURE)
        self.jar = self.root / "rars.jar"
        self.jar.write_bytes(b"controlled simulator fixture")
        self.jar_hash = hashlib.sha256(self.jar.read_bytes()).hexdigest()

    def config(self, **kw):
        values = dict(file=self.source, ex="bs", func="BinarySearch", grader=self.grader,
                      rars=self.jar, scratch=self.root, timeout=0.1)
        values.update(kw)
        return values

    def evidence(self, simulation, **kw):
        with patch.object(runner, "RARS_SHA256", self.jar_hash), patch.object(runner, "inspect_image", return_value={"digest": runner.DOCKER_IMAGE, "id": "sha256:fixture", "architecture": "arm64"}), patch.object(runner, "probe_sandbox", return_value={"verified": True}), patch.object(runner, "run_container", return_value=simulation):
            return runner.collect_evidence(**self.config(**kw))

    def test_command_is_sandboxed_and_immutable(self):
        cmd = runner.docker_command(self.source.parent, self.jar, "case.asm", "lab1-test")
        for flag, value in [("--network", "none"), ("--user", "65534:65534"), ("--pids-limit", "64"), ("--memory", "512m"), ("--cpus", "1"), ("--cap-drop", "ALL"), ("--security-opt", "no-new-privileges"), ("--pull", "never")]:
            self.assertEqual(cmd[cmd.index(flag)+1], value)
        self.assertIn("--read-only", cmd)
        self.assertIn("--tmpfs", cmd)
        mounts = [cmd[i+1] for i, v in enumerate(cmd) if v == "--mount"]
        self.assertEqual(len(mounts), 2)
        self.assertTrue(all("readonly" in m for m in mounts))
        self.assertNotIn("docker.sock", " ".join(cmd))
        self.assertIn(runner.DOCKER_IMAGE, cmd)
        self.assertIn("java", cmd)
        self.assertIn("2000000", cmd)

    def test_pass_has_exact_provenance_and_inputs(self):
        r = self.evidence(dict(stdout="@@RESULT@@=0\n", stderr="", returncode=0, duration=0.02, error=None))
        self.assertEqual((r["status"], r["passed"], r["total"]), ("completed", 1, 1))
        self.assertEqual(r["mode"], "function")
        self.assertEqual(r["jar"]["sha256"], self.jar_hash)
        self.assertEqual(r["grader"]["sha256"], hashlib.sha256(self.grader.read_bytes()).hexdigest())
        self.assertEqual(r["source"]["sha256"], hashlib.sha256(self.source.read_bytes()).hexdigest())
        t = r["tests"][0]
        self.assertEqual((t["index"], t["expected"], t["got"], t["status"]), (1, [0], 0, "pass"))
        self.assertEqual(t["input"], dict(A=[1], X=1))
        self.assertEqual(t["duration"], 0.02)
        self.assertEqual(len(r["suite"]["sha256"]), 64)
        self.assertEqual(r["adapter"]["classification"], "default_callable")
        self.assertEqual(r["not_evaluated"], ["ABI preservation", "console behaviour", "numeric final marks"])

    def test_memory_fallback_is_kernel_enforced_even_without_cgroup_memory(self):
        cmd = runner.docker_command(self.source.parent, self.jar, "case.asm", "lab1-test")
        self.assertIn('ulimit -d 524288 || exit 124; exec "$@"', cmd)
        self.assertNotIn("data=524288:524288", cmd)
        self.assertIn("-XX:+UseSerialGC", cmd)
        self.assertIn("-Xmx256m", cmd)

    def test_resource_warning_is_recorded_not_hidden(self):
        r = self.evidence(dict(stdout="@@RESULT@@=0", stderr="WARNING: Your kernel does not support memory limit capabilities or the cgroup is not mounted. Limitation discarded.", returncode=0, duration=0.02, error=None))
        self.assertEqual(r["limits"]["memory_enforcement"], "RLIMIT_DATA 512 MiB + JVM heap 256 MiB; cgroup memory unavailable")

    def test_wrong_answer_is_not_simulator_error(self):
        r = self.evidence(dict(stdout="@@RESULT@@=7", stderr="", returncode=0, duration=0.01, error=None))
        self.assertEqual(r["tests"][0]["status"], "fail")
        self.assertIsNone(r["tests"][0]["error"])

    def test_nondefault_registers_are_diagnostic(self):
        r = self.evidence(dict(stdout="@@RESULT@@=0", stderr="", returncode=0, duration=0.01, error=None), ret="a4")
        self.assertEqual(r["adapter"]["classification"], "callable_diagnostic")

    def test_adapter_system_exit_is_not_algorithm_failure(self):
        r = self.evidence({}, func="missing")
        self.assertEqual(r["status"], "adapter_error")
        self.assertEqual(r["tests"], [])
        self.assertIsNone(r["passed"])
        self.assertEqual(r["total"], 1)
        self.assertIn("Function not found", r["error"])

    def test_invalid_return_register_is_adapter_error(self):
        r = self.evidence({}, ret="t0")
        self.assertEqual(r["status"], "adapter_error")

    def test_modified_jar_is_rejected_before_simulator(self):
        with patch.object(runner, "RARS_SHA256", "0"*64), patch.object(runner, "run_container") as run:
            r = runner.collect_evidence(**self.config())
        self.assertEqual(r["status"], "configuration_error")
        run.assert_not_called()

    def test_safe_includes_are_snapshotted_without_source_mutation(self):
        self.source.write_text('.include "helpers/defs.asm"\nBinarySearch:\n ret\n')
        helper = self.source.parent / "helpers" / "defs.asm"
        helper.parent.mkdir()
        helper.write_text('.eqv LIMIT 4\n')
        before = {p: p.read_bytes() for p in (self.source, helper)}
        target = self.root / "snapshot"
        evidence = runner.snapshot_source(self.source, target)
        self.assertEqual(len(evidence), 2)
        self.assertEqual((target / "helpers/defs.asm").read_bytes(), before[helper])
        self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_include_escape_absolute_and_malformed_are_rejected(self):
        for include in ['"/etc/passwd"', '"../trusted_grade.py"', 'unquoted', '"missing.asm"', '"ok.asm" extra']:
            with self.subTest(include=include):
                self.source.write_text(f'.include {include}\nBinarySearch:\n ret\n')
                with self.assertRaises(ValueError):
                    runner.snapshot_source(self.source, self.root / "snapshot")

    def test_include_symlink_escape_is_rejected(self):
        (self.source.parent / "link.asm").symlink_to(self.grader)
        self.source.write_text('.include "link.asm"\nBinarySearch:\n ret\n')
        with self.assertRaises(ValueError):
            runner.snapshot_source(self.source, self.root / "snapshot")

    def test_include_cycle_is_rejected(self):
        self.source.write_text('.include "student.asm"\nBinarySearch:\n ret\n')
        with self.assertRaises(ValueError):
            runner.snapshot_source(self.source, self.root / "snapshot")

    def test_non_regular_include_is_rejected_without_reading(self):
        os.mkfifo(self.source.parent / "pipe.asm")
        self.source.write_text('.include "pipe.asm"\nBinarySearch:\n ret\n')
        original_read = Path.read_bytes
        def checked_read(path):
            self.assertNotEqual(path.name, "pipe.asm", "runner attempted to read FIFO")
            return original_read(path)
        with patch.object(Path, "read_bytes", checked_read), self.assertRaises(ValueError):
            runner.snapshot_source(self.source, self.root / "snapshot")

    def test_scratch_inside_student_directory_is_rejected(self):
        r = self.evidence({}, scratch=self.source.parent)
        self.assertEqual(r["status"], "adapter_error")
        self.assertIn("scratch", r["error"])

    def test_timeout_stops_named_container(self):
        with patch.object(runner, "limited_process", return_value=dict(stdout="partial", stderr="slow", returncode=None, error="timeout", duration=0.1)), patch.object(runner.subprocess, "run", return_value=subprocess.CompletedProcess(["docker", "rm"], 0, "", "")) as run:
            r = runner.run_container(self.source.parent, self.jar, "case.asm", timeout=0.1)
        self.assertEqual(r["error"], "timeout")
        self.assertEqual(r["stdout"], "partial")
        self.assertIsNone(r["returncode"])
        self.assertEqual(run.call_args_list[0].args[0][:3], ["docker", "rm", "--force"])

    def test_real_controlled_process_timeout(self):
        r = runner.limited_process([sys.executable, "-c", 'import time; print("partial", flush=True); time.sleep(5)'], 0.15)
        self.assertEqual(r["error"], "timeout")
        self.assertIn("partial", r["stdout"])
        self.assertLess(r["duration"], 2)

    def test_real_controlled_process_output_bound(self):
        with patch.object(runner, "MAX_CAPTURE_CHARS", 1024):
            r = runner.limited_process([sys.executable, "-c", 'import sys; sys.stdout.write("X" * 10000000)'], 2)
        self.assertEqual(r["error"], "output limit exceeded")
        self.assertLessEqual(len(r["stdout"]), 1024)

    def test_real_controlled_process_success(self):
        r = runner.limited_process([sys.executable, "-c", 'import sys; print("ok"); print("diagnostic", file=sys.stderr)'], 2)
        self.assertEqual((r["returncode"], r["error"], r["stdout"], r["stderr"]), (0, None, "ok\n", "diagnostic\n"))

    def test_sandbox_probe_failure_prevents_student_execution(self):
        with patch.object(runner, "RARS_SHA256", self.jar_hash), patch.object(runner, "inspect_image", return_value={}), patch.object(runner, "probe_sandbox", side_effect=ValueError("limits unavailable")), patch.object(runner, "run_container") as run:
            result = runner.collect_evidence(**self.config())
        self.assertEqual(result["status"], "configuration_error")
        run.assert_not_called()

    def test_simulator_failure_modes(self):
        samples = [(2, "", "bad instruction", "assemble error"), (3, "", "invalid address", "runtime error"), (0, "", "maximum step limit", "step limit"), (125, "", "daemon down", "container error"), (0, "", "", "function never returned"), (0, "@@RESULT@@=0\n@@RESULT@@=0", "", "ambiguous result")]
        for rc, out, err, expected in samples:
            with self.subTest(expected=expected):
                result = self.evidence(dict(stdout=out, stderr=err, returncode=rc, duration=0.1, error=None))
                self.assertEqual(result["tests"][0]["status"], "error")
                self.assertIn(expected, result["tests"][0]["error"])

    def test_extract_does_not_execute_original_run_test(self):
        self.grader.write_text(TRUSTED_FIXTURE + '\ndef run_test(*a):\n raise AssertionError("host simulator forbidden")\n')
        r = self.evidence(dict(stdout="@@RESULT@@=0", stderr="", returncode=0, duration=0.01, error=None))
        self.assertEqual(r["passed"], 1)


@unittest.skipUnless(os.environ.get("LAB1_RARS_JAR"), "set LAB1_RARS_JAR for isolated Docker integration")
class DockerIntegration(unittest.TestCase):
    def test_relative_include_in_readonly_snapshot(self):
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as tmp:
            original = Path(tmp)/"original"
            original.mkdir()
            source = original/"include.asm"
            helper = original/"helpers"/"defs.asm"
            helper.parent.mkdir()
            helper.write_text('.eqv FIXTURE_VALUE 7\n')
            source.write_text('.include "helpers/defs.asm"\n.text\nentry:\n li a0, FIXTURE_VALUE\n li a7, 1\n ecall\n li a7, 10\n ecall\n')
            before = {p: p.read_bytes() for p in (source, helper)}
            snapshot = Path(tmp)/"snapshot"
            runner.snapshot_source(source, snapshot)
            result = runner.run_container(snapshot, Path(os.environ["LAB1_RARS_JAR"]).resolve(), source.name)
            self.assertEqual((result["returncode"], result["error"], result["stdout"]), (0, None, "7"), result)
            self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_independent_binary_search_fixture(self):
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as tmp:
            source = Path(tmp) / "independent_bs.asm"
            source.write_text(BINARY_SEARCH_FIXTURE)
            before = source.read_bytes()
            evidence = runner.collect_evidence(file=source, ex="bs", func="BinarySearch", grader=repo/"Lab1/grade.py", rars=Path(os.environ["LAB1_RARS_JAR"]).resolve())
            self.assertEqual((evidence["status"], evidence["passed"], evidence["total"]), ("completed", 19, 19), json.dumps(evidence, indent=2))
            self.assertEqual(source.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
