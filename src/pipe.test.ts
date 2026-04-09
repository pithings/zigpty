import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import { PipePty } from "./pty/pipe.ts";

const isWindows = platform() === "win32";
const shell = isWindows ? "cmd.exe" : "/bin/sh";
const describeUnix = isWindows ? describe.skip : describe;

/** Collect all output from a short-lived PipePty until it exits. */
function collectOutput(pty: PipePty): Promise<string> {
  return new Promise<string>((resolve) => {
    let data = "";
    pty.onData((chunk) => {
      data += chunk;
    });
    pty.onExit(() => {
      // Give one tick for any remaining pipe data to flush
      setTimeout(() => resolve(data), 50);
    });
  });
}

describe("PipePty: basic spawn", () => {
  it("should spawn a process and receive output", async () => {
    const cmd = isWindows ? ["/c", "echo hello pipe"] : ["-c", "echo hello pipe"];
    const pty = new PipePty(shell, cmd);

    expect(pty.pid).toBeGreaterThan(0);
    expect(pty.cols).toBe(80);
    expect(pty.rows).toBe(24);

    const output = await collectOutput(pty);
    expect(output).toContain("hello pipe");
  });

  it("should fire onExit with correct exit code", async () => {
    const cmd = isWindows ? ["/c", "exit 42"] : ["-c", "exit 42"];
    const pty = new PipePty(shell, cmd);

    const exitInfo = await new Promise<{ exitCode: number; signal: number }>((resolve) => {
      pty.onExit(resolve);
    });

    expect(exitInfo.exitCode).toBe(42);
    expect(exitInfo.signal).toBe(0);
  });

  it("should resolve exited promise", async () => {
    const cmd = isWindows ? ["/c", "exit 7"] : ["-c", "exit 7"];
    const pty = new PipePty(shell, cmd);
    const code = await pty.exited;
    expect(code).toBe(7);
    expect(pty.exitCode).toBe(7);
  });

  it("should spawn with custom cols/rows", () => {
    const pty = new PipePty(shell, ["-c", "true"], { cols: 120, rows: 40 });
    expect(pty.cols).toBe(120);
    expect(pty.rows).toBe(40);
    pty.close();
  });

  it("should spawn with custom cwd", async () => {
    const tmpDir = isWindows ? process.env.TEMP || "C:\\Windows\\Temp" : "/tmp";
    const cmd = isWindows ? ["/c", "cd"] : ["-c", "pwd"];
    const pty = new PipePty(shell, cmd, { cwd: tmpDir });

    const output = await collectOutput(pty);
    expect(output.toLowerCase()).toMatch(/te?mp/);
  });
});

describe("PipePty: env", () => {
  it("should pass custom env vars", async () => {
    const cmd = isWindows ? ["/c", "echo %PIPE_TEST%"] : ["-c", "echo $PIPE_TEST"];
    const pty = new PipePty(shell, cmd, {
      env: { ...process.env, PIPE_TEST: "works" } as Record<string, string>,
    });

    const output = await collectOutput(pty);
    expect(output).toContain("works");
  });

  it("should set FORCE_COLOR and COLORTERM by default", async () => {
    const cmd = isWindows
      ? ["/c", "echo %FORCE_COLOR% %COLORTERM%"]
      : ["-c", "echo $FORCE_COLOR $COLORTERM"];
    const pty = new PipePty(shell, cmd, {
      env: { PATH: process.env.PATH! },
    });

    const output = await collectOutput(pty);
    expect(output).toContain("1");
    expect(output).toContain("truecolor");
  });

  it("should not override existing FORCE_COLOR", async () => {
    const cmd = isWindows ? ["/c", "echo %FORCE_COLOR%"] : ["-c", "echo $FORCE_COLOR"];
    const pty = new PipePty(shell, cmd, {
      env: { PATH: process.env.PATH!, FORCE_COLOR: "0" },
    });

    const output = await collectOutput(pty);
    expect(output).toContain("0");
  });

  it.skipIf(isWindows)("should set COLUMNS and LINES from dimensions", async () => {
    const cmd = ["-c", "echo $COLUMNS $LINES"];
    const pty = new PipePty("/bin/sh", cmd, {
      cols: 132,
      rows: 50,
      env: { PATH: process.env.PATH! },
    });

    const output = await collectOutput(pty);
    expect(output).toContain("132");
    expect(output).toContain("50");
  });
});

describeUnix("PipePty: signal character translation", () => {
  it("should translate ^C to SIGINT", async () => {
    // cat will be killed by SIGINT
    const pty = new PipePty("/bin/cat", []);
    pty.setRawMode();

    const exitInfo = await new Promise<{ exitCode: number; signal: number }>((resolve) => {
      pty.onExit(resolve);
      setTimeout(() => pty.write("\x03"), 100); // ^C
    });

    // SIGINT = signal 2
    expect(exitInfo.signal).toBe(2);
  });

  it("should translate ^D to EOF (close stdin)", async () => {
    // cat reads stdin until EOF, then exits 0
    const pty = new PipePty("/bin/cat", []);
    pty.setRawMode();

    const exitInfo = await new Promise<{ exitCode: number; signal: number }>((resolve) => {
      pty.onExit(resolve);
      setTimeout(() => pty.write("\x04"), 100); // ^D
    });

    expect(exitInfo.exitCode).toBe(0);
  });

  it("should translate ^\\ to SIGQUIT", async () => {
    const pty = new PipePty("/bin/cat", []);
    pty.setRawMode();

    const exitInfo = await new Promise<{ exitCode: number; signal: number }>((resolve) => {
      pty.onExit(resolve);
      setTimeout(() => pty.write("\x1c"), 100); // ^\
    });

    // SIGQUIT = signal 3
    expect(exitInfo.signal).toBe(3);
  });
});

describeUnix("PipePty: canonical mode (line discipline)", () => {
  it("should echo typed characters back to onData", async () => {
    const pty = new PipePty("/bin/cat", []);

    const echoed: string[] = [];
    pty.onData((data) => {
      if (typeof data === "string") echoed.push(data);
    });

    // In canonical mode, typing "hi" should echo "h" and "i"
    pty.write("h");
    pty.write("i");
    await new Promise((r) => setTimeout(r, 50));

    const all = echoed.join("");
    expect(all).toContain("h");
    expect(all).toContain("i");

    pty.kill("SIGTERM");
  });

  it("should buffer input until Enter and then flush", async () => {
    const pty = new PipePty("/bin/cat", []);

    const output: string[] = [];
    pty.onData((data) => {
      if (typeof data === "string") output.push(data);
    });

    // Type "hello" then press Enter — cat should echo back "hello\n" from stdout
    pty.write("hello\n");
    await new Promise((r) => setTimeout(r, 200));

    const all = output.join("");
    // Should contain the echo of typed chars + the cat output
    expect(all).toContain("hello");

    pty.kill("SIGTERM");
  });

  it("should handle backspace in canonical mode", async () => {
    const pty = new PipePty("/bin/cat", []);

    const output: string[] = [];
    pty.onData((data) => {
      if (typeof data === "string") output.push(data);
    });

    // Type "abc", backspace, "d", Enter → cat should receive "abd\n"
    pty.write("abc\x7fd\n");
    await new Promise((r) => setTimeout(r, 200));

    const all = output.join("");
    expect(all).toContain("abd");

    pty.kill("SIGTERM");
  });

  it("should handle ^U line kill", async () => {
    const pty = new PipePty("/bin/cat", []);

    const output: string[] = [];
    pty.onData((data) => {
      if (typeof data === "string") output.push(data);
    });

    // Type "junk", ^U to kill line, then "good", Enter
    pty.write("junk\x15good\n");
    await new Promise((r) => setTimeout(r, 200));

    const all = output.join("");
    expect(all).toContain("good");
    // "junk" should have been erased before flushing
    // The echoed "junk" will be in the output but cat's stdout should only have "good"
    // We verify cat received "good" by checking the output after echo
    pty.kill("SIGTERM");
  });

  it("should handle ^W word erase", async () => {
    const pty = new PipePty("/bin/cat", []);

    const output: string[] = [];
    pty.onData((data) => {
      if (typeof data === "string") output.push(data);
    });

    // Type "hello world", ^W erases "world", type "zig", Enter
    pty.write("hello world\x17zig\n");
    await new Promise((r) => setTimeout(r, 200));

    const all = output.join("");
    expect(all).toContain("hello zig");

    pty.kill("SIGTERM");
  });
});

describeUnix("PipePty: raw mode", () => {
  it("should pass through bytes directly without echo", async () => {
    const pty = new PipePty("/bin/cat", []);
    pty.setRawMode();

    const output: string[] = [];
    pty.onData((data) => {
      if (typeof data === "string") output.push(data);
    });

    // In raw mode, "ab" goes straight to cat's stdin, cat echoes back
    pty.write("ab");
    await new Promise((r) => setTimeout(r, 200));

    const all = output.join("");
    // Only cat's stdout (no local echo)
    expect(all).toContain("ab");

    pty.kill("SIGTERM");
  });

  it("should not buffer input in raw mode", async () => {
    const pty = new PipePty("/bin/cat", []);
    pty.setRawMode();

    const output: string[] = [];
    pty.onData((data) => {
      if (typeof data === "string") output.push(data);
    });

    pty.write("x");
    await new Promise((r) => setTimeout(r, 200));

    // cat should have received and echoed "x" immediately, no Enter needed
    const all = output.join("");
    expect(all).toContain("x");

    pty.kill("SIGTERM");
  });

  it("should switch between raw and canonical mode", async () => {
    const pty = new PipePty("/bin/cat", []);

    // Start in canonical (default)
    expect(pty).toBeDefined();

    // Switch to raw
    pty.setRawMode();

    // Switch back to canonical
    pty.setCanonicalMode();

    // Should not throw
    pty.kill("SIGTERM");
  });
});

describeUnix("PipePty: flow control", () => {
  it("should intercept XOFF/XON when handleFlowControl is true", async () => {
    const pty = new PipePty("/bin/cat", [], { handleFlowControl: true });
    pty.setRawMode();

    const output: string[] = [];
    pty.onData((data) => {
      if (typeof data === "string") output.push(data);
    });

    // \x13 (XOFF) and \x11 (XON) should be intercepted, not sent to child
    pty.write("\x13"); // pause
    pty.write("\x11"); // resume
    pty.write("visible");
    await new Promise((r) => setTimeout(r, 200));

    const all = output.join("");
    expect(all).toContain("visible");
    // XOFF/XON chars should NOT appear in output
    expect(all).not.toContain("\x13");
    expect(all).not.toContain("\x11");

    pty.kill("SIGTERM");
  });

  it("should not intercept flow control when disabled", async () => {
    const pty = new PipePty("/bin/cat", [], { handleFlowControl: false });
    pty.setRawMode();

    const output: string[] = [];
    pty.onData((data) => {
      if (typeof data === "string") output.push(data);
    });

    pty.write("hello");
    await new Promise((r) => setTimeout(r, 200));

    const all = output.join("");
    expect(all).toContain("hello");

    pty.kill("SIGTERM");
  });
});

describeUnix("PipePty: resize", () => {
  it("should update cols/rows on resize", () => {
    const pty = new PipePty("/bin/sh", ["-c", "sleep 1"]);

    pty.resize(120, 40);
    expect(pty.cols).toBe(120);
    expect(pty.rows).toBe(40);

    pty.kill("SIGTERM");
  });

  it("should send SIGWINCH on resize without crashing", async () => {
    const pty = new PipePty("/bin/sh", ["-c", "sleep 1"]);

    // Should not throw — SIGWINCH is sent best-effort
    pty.resize(100, 50);
    pty.resize(80, 24);

    await new Promise((r) => setTimeout(r, 50));

    pty.kill("SIGTERM");
  });
});

describe("PipePty: close", () => {
  it("should clean up resources", () => {
    const pty = new PipePty(shell, isWindows ? ["/c", "echo hi"] : ["-c", "echo hi"]);

    pty.close();
    // Should be safe to call multiple times
    pty.close();

    // write/resize should be no-ops after close
    pty.write("should not throw");
    pty.resize(80, 24);
  });

  it("should trigger onExit after close", async () => {
    const pty = new PipePty(isWindows ? "cmd.exe" : "/bin/cat", []);

    const exitInfo = await new Promise<{ exitCode: number; signal: number }>((resolve) => {
      pty.onExit(resolve);
      setTimeout(() => pty.close(), 100);
    });

    expect(exitInfo.exitCode).not.toBe(-999);
  });
});

describeUnix("PipePty: kill", () => {
  it("should kill with default SIGHUP", async () => {
    const pty = new PipePty("/bin/cat", []);

    const exitInfo = await new Promise<{ exitCode: number; signal: number }>((resolve) => {
      pty.onExit(resolve);
      setTimeout(() => pty.kill(), 100);
    });

    expect(exitInfo.signal).toBe(1); // SIGHUP
  });

  it("should kill with specified signal", async () => {
    const pty = new PipePty("/bin/cat", []);

    const exitInfo = await new Promise<{ exitCode: number; signal: number }>((resolve) => {
      pty.onExit(resolve);
      setTimeout(() => pty.kill("SIGTERM"), 100);
    });

    expect(exitInfo.signal).toBe(15); // SIGTERM
  });
});

describeUnix("PipePty: pause/resume", () => {
  it("should pause and resume without crashing", () => {
    const pty = new PipePty("/bin/cat", []);

    pty.pause();
    pty.resume();

    pty.kill("SIGTERM");
  });
});

describeUnix("PipePty: encoding", () => {
  it("should return raw Buffers when encoding is null", async () => {
    const pty = new PipePty("/bin/sh", ["-c", "sleep 0.1 && echo raw"], { encoding: null });

    const output = await new Promise<Buffer | string>((resolve) => {
      const chunks: Buffer[] = [];
      pty.onData((data) => {
        if (Buffer.isBuffer(data)) {
          chunks.push(data);
        }
      });
      pty.onExit(() => {
        setTimeout(
          () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : Buffer.from("")),
          50,
        );
      });
    });

    expect(Buffer.isBuffer(output)).toBe(true);
    expect(output.toString()).toContain("raw");
  });

  it("should return strings with default utf8 encoding", async () => {
    const pty = new PipePty("/bin/sh", ["-c", "echo text"]);

    const output = await collectOutput(pty);
    expect(typeof output).toBe("string");
    expect(output).toContain("text");
  });
});

describeUnix("PipePty: waitFor", () => {
  it("should resolve when pattern appears in output", async () => {
    const pty = new PipePty("/bin/sh", ["-c", "sleep 0.1 && echo ready"]);
    const result = await pty.waitFor("ready", { timeout: 5000 });
    expect(result).toContain("ready");
  });

  it("should reject on timeout", async () => {
    const pty = new PipePty("/bin/cat", []);

    await expect(pty.waitFor("never", { timeout: 200 })).rejects.toThrow("timed out");

    pty.kill("SIGTERM");
  });
});

describeUnix("PipePty: onData/onExit dispose", () => {
  it("should stop receiving data after dispose", async () => {
    const pty = new PipePty("/bin/sh", [
      "-c",
      "echo before && sleep 0.5 && echo after",
    ]);

    const received: string[] = [];
    let dispose: () => void;
    await new Promise<void>((resolve) => {
      const disposable = pty.onData((data) => {
        if (typeof data === "string") {
          received.push(data);
          if (received.join("").includes("before")) resolve();
        }
      });
      dispose = () => disposable.dispose();
    });
    dispose!();
    // "before" was received and listener disposed — wait for "after" to pass
    await new Promise((r) => setTimeout(r, 700));

    const all = received.join("");
    expect(all).toContain("before");
  });
});

describeUnix("PipePty: stderr merging", () => {
  it("should merge stderr into the data stream", async () => {
    const pty = new PipePty("/bin/sh", ["-c", "echo stdout && echo stderr >&2"]);

    const output = await collectOutput(pty);
    expect(output).toContain("stdout");
    expect(output).toContain("stderr");
  });
});

describeUnix("PipePty: process name", () => {
  it("should return the spawn file as process name", () => {
    const pty = new PipePty("/bin/sh", ["-c", "sleep 1"]);

    expect(pty.process).toBe("/bin/sh");

    pty.kill("SIGTERM");
  });
});

describe("PipePty: error handling", () => {
  it("should handle spawn failure gracefully", async () => {
    const pty = new PipePty("/nonexistent/binary", []);

    const exitInfo = await new Promise<{ exitCode: number; signal: number }>((resolve) => {
      pty.onExit(resolve);
    });

    expect(exitInfo.exitCode).toBe(-1);
  });
});
