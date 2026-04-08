#!/usr/bin/env python3
"""
Clerk agent launcher with auto-accept for interactive prompts.

Wraps Claude Code in a PTY and automatically accepts:
- Development channels confirmation ("I am using this for local development")
- Workspace trust dialog ("Yes, I trust this folder")
- Settings error dialog ("Continue without these settings")
- Dangerous permissions dialog ("Yes, I accept")

Two strategies:
1. Native Linux: TIOCSTI ioctl for reliable keystroke injection
2. Fallback: expect (if installed) or os.write to master fd

Usage:
    autoaccept.py <start-script> [log-file]
"""
import pty, os, sys, time, select, signal, struct, fcntl

TIOCSTI = 0x5412  # Linux ioctl: inject char into terminal input queue


def inject_char(fd: int, char: int) -> bool:
    """Inject a single character via TIOCSTI. Returns True on success."""
    try:
        fcntl.ioctl(fd, TIOCSTI, struct.pack("B", char))
        return True
    except OSError:
        return False


def inject_enter(fd: int) -> bool:
    """Inject Enter (CR) keystroke."""
    return inject_char(fd, 13)


def inject_down_enter(fd: int) -> bool:
    """Inject Down Arrow + Enter."""
    ok = True
    for byte in b"\x1b[B":
        ok = ok and inject_char(fd, byte)
    time.sleep(0.2)
    ok = ok and inject_char(fd, 13)
    return ok


def test_tiocsti(slave_path: str) -> int | None:
    """Test if TIOCSTI works. Returns slave fd or None."""
    try:
        fd = os.open(slave_path, os.O_RDWR)
        # Test with a harmless NUL byte — won't affect the terminal
        fcntl.ioctl(fd, TIOCSTI, struct.pack("B", 0))
        return fd
    except (OSError, PermissionError):
        try:
            os.close(fd)
        except Exception:
            pass
        return None


def send_via_master(master_fd: int, data: bytes):
    """Fallback: write to master fd (less reliable with TUI prompts)."""
    os.write(master_fd, data)


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <start-script> [log-file]", file=sys.stderr)
        sys.exit(1)

    start_sh = sys.argv[1]
    log_path = sys.argv[2] if len(sys.argv) > 2 else None

    # Fork with a new PTY
    pid, master_fd = pty.fork()

    if pid == 0:
        # Child: exec the start script
        os.execvp("/bin/bash", ["/bin/bash", "-l", start_sh])
        sys.exit(1)

    # Wait for child to start, then test TIOCSTI on its slave PTY
    time.sleep(1)
    try:
        slave_path = os.readlink(f"/proc/{pid}/fd/0")
    except Exception:
        slave_path = ""

    slave_fd = test_tiocsti(slave_path) if slave_path else None
    use_tiocsti = slave_fd is not None

    if use_tiocsti:
        print(f"autoaccept: TIOCSTI available on {slave_path}", file=sys.stderr)
    else:
        print(
            "autoaccept: TIOCSTI unavailable (WSL2?), falling back to master fd writes",
            file=sys.stderr,
        )

    # Parent: read output, auto-accept prompts
    log = open(log_path, "wb") if log_path else None
    buf = b""
    prompts_handled: set[str] = set()

    def cleanup_and_exit(code=0):
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, OSError):
            pass
        if log:
            log.close()
        if slave_fd is not None:
            try:
                os.close(slave_fd)
            except OSError:
                pass
        sys.exit(code)

    signal.signal(signal.SIGTERM, lambda *_: cleanup_and_exit(0))
    signal.signal(signal.SIGINT, lambda *_: cleanup_and_exit(0))

    def accept_enter(prompt_name: str):
        """Send Enter to accept a prompt."""
        if prompt_name in prompts_handled:
            return
        time.sleep(0.8)
        if use_tiocsti:
            inject_enter(slave_fd)
        else:
            send_via_master(master_fd, b"\r")
        prompts_handled.add(prompt_name)

    def accept_down_enter(prompt_name: str):
        """Send Down+Enter to select option 2."""
        if prompt_name in prompts_handled:
            return
        time.sleep(0.5)
        if use_tiocsti:
            inject_down_enter(slave_fd)
        else:
            send_via_master(master_fd, b"\x1b[B\r")
        prompts_handled.add(prompt_name)

    while True:
        try:
            r, _, _ = select.select([master_fd], [], [], 1.0)
            if r:
                data = os.read(master_fd, 8192)
                if not data:
                    break
                if log:
                    log.write(data)
                    log.flush()
                buf += data

                # Dev channels: "Enter to confirm" + "local development"
                if b"local development" in buf and b"Enter to confirm" in buf:
                    accept_enter("dev-channels")
                    buf = b""

                # Trust: "trust this folder" + "Enter to confirm"
                elif b"trust this folder" in buf and b"Enter to confirm" in buf:
                    accept_enter("trust")
                    buf = b""

                # Settings error: "Continue without these settings"
                elif b"Continue without these settings" in buf:
                    accept_down_enter("settings")
                    buf = b""

                # Dangerous permissions: "Yes, I accept"
                elif b"Yes, I accept" in buf and b"Enter to confirm" in buf:
                    accept_down_enter("dangerous")
                    buf = b""

                # Generic catch-all "Enter to confirm"
                elif b"Enter to confirm" in buf and b"Esc to cancel" in buf:
                    # Only if we haven't handled a specific prompt above
                    if not any(
                        p in buf
                        for p in [
                            b"local development",
                            b"trust this folder",
                            b"Continue without",
                            b"Yes, I accept",
                        ]
                    ):
                        accept_enter(f"generic-{len(prompts_handled)}")
                        buf = b""

                # Keep buffer bounded
                if len(buf) > 100000:
                    buf = buf[-20000:]

        except OSError:
            break

    # Wait for child
    try:
        _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        status = 0
    if log:
        log.close()
    if slave_fd is not None:
        try:
            os.close(slave_fd)
        except OSError:
            pass
    sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)


if __name__ == "__main__":
    main()
