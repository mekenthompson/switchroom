"""Exit-code contract for recall.py's top-level exception handler.

Switchroom #1070. Before this fix, an uncaught exception in the
``__main__`` block exited 0 in non-debug mode — so ``bin/run-hook.sh``
saw a successful run and the #424 issue-sink never captured the
silent memory outage. The agent's ``<hindsight_memories>`` block
silently went empty.

The contract these tests pin:

* Non-debug uncaught exception → exit code 2, empty stdout, stderr
  contains the exception class + message but NOT a full traceback.
* Debug uncaught exception → exit code 2 still (unchanged), stderr
  carries the traceback for live debugging.

The fault is injected by monkey-patching ``lib.config.load_config``
to raise inside ``main()``, which propagates to the top-level
handler. We run the script as a subprocess so the real
``if __name__ == '__main__':`` block executes.
"""

import json
import os
import subprocess
import sys
import textwrap


SCRIPTS_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "scripts")
)
RECALL_PY = os.path.join(SCRIPTS_DIR, "recall.py")


def _run_recall_with_injected_fault(
    tmp_path,
    debug=False,
    fault_message="boom: simulated fault",
):
    """Run recall.py as a subprocess after injecting a fault into a
    lib helper called *during* main() so the top-level except handler
    fires. We target ``lib.gateway_ipc.extract_chat_id_from_prompt``
    because it's called unconditionally in the recall flow and
    crucially does NOT touch lib.config — so the handler's own
    ``load_config()`` call (used to decide on traceback verbosity)
    still works.

    Returns the CompletedProcess.
    """
    shim = tmp_path / "fault_shim.py"
    shim.write_text(
        textwrap.dedent(
            f"""\
            import sys, os, runpy
            sys.path.insert(0, {SCRIPTS_DIR!r})
            from lib import gateway_ipc as _gw

            def _boom(*a, **kw):
                raise RuntimeError({fault_message!r})

            _gw.extract_chat_id_from_prompt = _boom

            # Run recall.py as __main__ so the top-level try/except
            # block executes exactly as it does in production.
            runpy.run_path({RECALL_PY!r}, run_name="__main__")
            """
        )
    )

    env = os.environ.copy()
    # Strip any real HINDSIGHT_* / CLAUDE_PLUGIN_* env that might bleed in
    for key in list(env):
        if key.startswith(("HINDSIGHT_", "CLAUDE_PLUGIN_")):
            env.pop(key, None)
    env["HOME"] = str(tmp_path)
    env["CLAUDE_PLUGIN_ROOT"] = str(tmp_path / "plugin_root")
    env["CLAUDE_PLUGIN_DATA"] = str(tmp_path / "plugin_data")
    (tmp_path / "plugin_root").mkdir(exist_ok=True)
    (tmp_path / "plugin_data").mkdir(exist_ok=True)
    if debug:
        env["HINDSIGHT_DEBUG"] = "1"

    proc = subprocess.run(
        [sys.executable, str(shim)],
        input=json.dumps({"prompt": "anything", "session_id": "s"}),
        capture_output=True,
        text=True,
        env=env,
        timeout=10,
    )
    return proc


class TestRecallExitCodes:
    def test_nondebug_uncaught_exits_two(self, tmp_path):
        """The headline contract: non-debug uncaught → exit 2 so the
        wrapper's record_failure path fires."""
        proc = _run_recall_with_injected_fault(tmp_path, debug=False)
        assert proc.returncode == 2, (
            f"expected exit 2, got {proc.returncode}; "
            f"stderr={proc.stderr!r}"
        )

    def test_nondebug_stdout_is_safe_empty(self, tmp_path):
        """Stdout must be empty (matches the no-memories success
        shape) so the agent's prompt assembly doesn't try to parse
        an error message as JSON."""
        proc = _run_recall_with_injected_fault(tmp_path, debug=False)
        assert proc.stdout.strip() == "", (
            f"expected empty stdout, got {proc.stdout!r}"
        )

    def test_nondebug_stderr_includes_class_and_message(self, tmp_path):
        """The wrapper attaches the last ~60 lines of stderr to the
        recorded issue, so the class + message must be present."""
        proc = _run_recall_with_injected_fault(
            tmp_path, debug=False, fault_message="kaboom-1070"
        )
        assert "RuntimeError" in proc.stderr
        assert "kaboom-1070" in proc.stderr
        assert "Unexpected error in recall" in proc.stderr

    def test_nondebug_stderr_omits_traceback(self, tmp_path):
        """#1069 threat model: don't dump tracebacks (which may
        include local-variable repr in some frames or framework
        internals) to unredacted stderr unless debug mode is on."""
        proc = _run_recall_with_injected_fault(tmp_path, debug=False)
        # The Python traceback module emits "Traceback (most recent
        # call last):" as the first line. Its absence is the cheap,
        # unambiguous check.
        assert "Traceback (most recent call last)" not in proc.stderr, (
            f"non-debug stderr leaked traceback: {proc.stderr!r}"
        )

    def test_debug_includes_traceback(self, tmp_path):
        """In debug mode, the traceback is allowed — operators run
        with HINDSIGHT_DEBUG=1 explicitly when they're chasing a
        broken recall and need the full stack."""
        proc = _run_recall_with_injected_fault(tmp_path, debug=True)
        assert "Traceback (most recent call last)" in proc.stderr, (
            f"debug stderr missing traceback: {proc.stderr!r}"
        )

    def test_debug_still_exits_nonzero(self, tmp_path):
        """Debug mode previously exited 2; we preserve that so
        live-debugging operators see the same exit code shape they
        always have."""
        proc = _run_recall_with_injected_fault(tmp_path, debug=True)
        assert proc.returncode == 2
