import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import { open, spawn } from "./index.ts";

const isWindows = platform() === "win32";
const shell = isWindows ? "cmd.exe" : "/bin/sh";
const describeUnix = isWindows ? describe.skip : describe;
const describeWindows = isWindows ? describe : describe.skip;

describe("spawn", () => {
  it("should spawn a process and receive output", async () => {
    const cmd = isWindows ? ["/c", "echo hello zigpty"] : ["-c", "sleep 0.05 && echo hello zigpty"];
    const pty = spawn(shell, cmd);

    expect(pty.pid).toBeGreaterThan(0);
    expect(pty.cols).toBe(80);
    expect(pty.rows).toBe(24);

    const output = await new Promise<string>((resolve) => {
      let data = "";
      pty.onData((chunk) => {
        data += chunk;
        if (data.includes("hello zigpty")) resolve(data);
      });
      setTimeout(() => resolve(data), 5000);
    });

    expect(output).toContain("hello zigpty");
  });

  it("should fire onExit callback", async () => {
    const cmd = isWindows ? ["/c", "exit 42"] : ["-c", "exit 42"];
    const pty = spawn(shell, cmd);

    const exitInfo = await new Promise<{ exitCode: number; signal: number }>((resolve) => {
      pty.onExit(resolve);
      setTimeout(() => resolve({ exitCode: -1, signal: -1 }), 5000);
    });

    expect(exitInfo.exitCode).toBe(42);
    expect(exitInfo.signal).toBe(0);
  });

  it("should write data to the PTY", async () => {
    const cmd = isWindows ? [] : [];
    const exe = isWindows ? "cmd.exe" : "/bin/cat";
    const pty = spawn(exe, cmd);

    const output = await new Promise<string>((resolve) => {
      let data = "";
      pty.onData((chunk) => {
        data += chunk;
        if (data.includes("test input")) resolve(data);
      });

      setTimeout(() => pty.write("test input\n"), 200);
      setTimeout(() => resolve(data), 5000);
    });

    expect(output).toContain("test input");
    pty.kill(isWindows ? undefined : "SIGTERM");
  });

  it("should resize the PTY", async () => {
    const pty = spawn(shell);

    pty.resize(120, 40);
    expect(pty.cols).toBe(120);
    expect(pty.rows).toBe(40);

    if (!isWindows) {
      const output = await new Promise<string>((resolve) => {
        let data = "";
        pty.onData((chunk) => {
          data += chunk;
          if (data.includes("40") && data.includes("120")) resolve(data);
        });

        setTimeout(() => pty.write("stty size\n"), 100);
        setTimeout(() => resolve(data), 2000);
      });

      expect(output).toContain("40 120");
    }

    pty.kill(isWindows ? undefined : "SIGTERM");
  });

  it("should spawn with custom cwd", async () => {
    const tmpDir = isWindows ? process.env.TEMP || "C:\\Windows\\Temp" : "/tmp";
    const cmd = isWindows ? ["/c", "cd"] : [];
    const exe = isWindows ? "cmd.exe" : "/bin/pwd";
    const pty = spawn(exe, cmd, { cwd: tmpDir });

    const output = await new Promise<string>((resolve) => {
      let data = "";
      pty.onData((chunk) => {
        data += chunk;
        if (data.includes(tmpDir) || data.includes("/tmp") || data.includes("/private/tmp"))
          resolve(data);
      });
      setTimeout(() => resolve(data), 5000);
    });

    // On macOS, /tmp is a symlink to /private/tmp
    expect(output.toLowerCase()).toContain(isWindows ? tmpDir.toLowerCase() : "tmp");
  });

  it("should spawn with custom env", { timeout: 10_000 }, async () => {
    const cmd = isWindows
      ? ["/c", "echo %ZIGPTY_TEST%"]
      : ["-c", "sleep 0.05 && echo $ZIGPTY_TEST"];
    const pty = spawn(shell, cmd, {
      env: { ...process.env, ZIGPTY_TEST: "works" } as Record<string, string>,
    });

    const output = await new Promise<string>((resolve) => {
      let data = "";
      pty.onData((chunk) => {
        data += chunk;
        if (data.includes("works")) resolve(data);
      });
      setTimeout(() => resolve(data), 8000);
    });

    expect(output).toContain("works");
  });
});

async function pollStats<T>(
  pty: { stats(): T | null },
  predicate: (s: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = pty.stats();
    if (s !== null && predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("pollStats timed out");
}

describe("stats", () => {
  it("should report pid, rss, and cpu times", async () => {
    const exe = isWindows ? "cmd.exe" : "/bin/cat";
    const pty = spawn(exe);

    const stats = await pollStats(pty, (s) => s.pid > 0 && s.rssBytes > 0);
    expect(stats.cpuUser).toBeGreaterThanOrEqual(0);
    expect(stats.cpuSys).toBeGreaterThanOrEqual(0);

    pty.kill();
    await pty.exited;
  });

  it.skipIf(isWindows)("should report cwd on unix", async () => {
    // macOS resolves /tmp → /private/tmp; pass the canonical path so proc_pidinfo's
    // PROC_PIDVNODEPATHINFO returns an equal string.
    const tmpDir = process.platform === "darwin" ? "/private/tmp" : "/tmp";
    const pty = spawn("/bin/cat", [], { cwd: tmpDir });

    const stats = await pollStats(pty, (s) => s.cwd === tmpDir);
    expect(stats.cwd).toBe(tmpDir);

    pty.kill();
    await pty.exited;
  });

  it("should return null after close", async () => {
    const exe = isWindows ? "cmd.exe" : "/bin/cat";
    const pty = spawn(exe);
    pty.close();
    expect(pty.stats()).toBeNull();
    await pty.exited;
  });

  it("should aggregate child processes", async () => {
    // Unix: sh runs two `sleep` children in a single pgrp — aggregation should
    // see count=3 (sh + 2 sleeps).
    // Windows: cmd uses `start /B` to actually background two pings in its
    // descendant tree (cmd's `&` is sequential, not parallel).
    const [exe, args] = isWindows
      ? [
          "cmd.exe",
          ["/c", "start /B ping -n 10 127.0.0.1 && start /B ping -n 10 127.0.0.1 && timeout /t 10"],
        ]
      : ["/bin/sh", ["-c", "sleep 2 & sleep 2 & wait"]];
    const pty = spawn(exe, args);

    const stats = await pollStats(pty, (s) => s.count >= 3 && s.children.length >= 2);
    expect(stats.count).toBeGreaterThanOrEqual(3);
    expect(stats.children.length).toBeGreaterThanOrEqual(2);
    for (const c of stats.children) {
      expect(c.pid).toBeGreaterThan(0);
      expect(typeof c.name).toBe("string");
      expect(c.rssBytes).toBeGreaterThanOrEqual(0);
    }

    pty.kill();
    await pty.exited;
  });
});

describeUnix("process name (unix)", () => {
  it("should report foreground process name", async () => {
    const pty = spawn("/bin/bash");

    await new Promise((r) => setTimeout(r, 200));

    const processName = pty.process;
    // Under QEMU emulation, /proc reports "qemu-aarch64-static" instead of the actual process
    if (process.env.ZIGPTY_QEMU) {
      expect(processName).toBe("qemu-aarch64-static");
    } else {
      expect(processName).toBe("bash");
    }

    pty.kill("SIGTERM");
  });
});

describe("encoding", () => {
  it("should return raw Buffers when encoding is null", async () => {
    const cmd = isWindows ? ["/c", "echo raw"] : ["-c", "sleep 0.05 && echo raw"];
    const pty = spawn(shell, cmd, { encoding: null });

    const output = await new Promise<Buffer | string>((resolve) => {
      let gotBuffer = false;
      const chunks: Buffer[] = [];
      pty.onData((data) => {
        if (Buffer.isBuffer(data)) {
          gotBuffer = true;
          chunks.push(data);
          if (Buffer.concat(chunks).toString().includes("raw")) resolve(Buffer.concat(chunks));
        }
      });
      setTimeout(() => resolve(gotBuffer ? Buffer.concat(chunks) : "timeout"), 5000);
    });

    expect(Buffer.isBuffer(output)).toBe(true);
    expect(output.toString()).toContain("raw");
  });

  it("should return strings with default utf8 encoding", async () => {
    const cmd = isWindows ? ["/c", "echo text"] : ["-c", "sleep 0.05 && echo text"];
    const pty = spawn(shell, cmd);

    const output = await new Promise<string | Buffer>((resolve) => {
      let data = "";
      pty.onData((chunk) => {
        data += chunk;
        if (data.includes("text")) resolve(data);
      });
      setTimeout(() => resolve(data), 5000);
    });

    expect(typeof output).toBe("string");
    expect(output).toContain("text");
  });
});

describeUnix("open (unix)", () => {
  it("should open a bare PTY pair", () => {
    const result = open({ cols: 100, rows: 50 });

    expect(result.master).toBeGreaterThan(0);
    expect(result.slave).toBeGreaterThan(0);
    expect(result.pty).toMatch(/^\/dev\/(pts\/\d+|ttys\d+)$/);
  });

  it("should use default dimensions", () => {
    const result = open();

    expect(result.master).toBeGreaterThan(0);
    expect(result.slave).toBeGreaterThan(0);
    expect(result.pty).toMatch(/^\/dev\/(pts\/\d+|ttys\d+)$/);
  });
});

describeWindows("open (windows)", () => {
  it("should throw on Windows", () => {
    expect(() => open()).toThrow("not supported on Windows");
  });
});

describeUnix("resize (unix)", () => {
  it("should accept pixel dimensions", async () => {
    const pty = spawn("/bin/sh");

    pty.resize(100, 50, { width: 800, height: 600 });
    expect(pty.cols).toBe(100);
    expect(pty.rows).toBe(50);

    pty.kill("SIGTERM");
  });

  it("should handle edge-case dimensions without crashing", () => {
    const pty = spawn("/bin/sh");

    // Zero dimensions
    pty.resize(0, 0);
    expect(pty.cols).toBe(0);
    expect(pty.rows).toBe(0);

    // Very large dimensions (clamped to u16 max internally)
    pty.resize(99999, 99999);

    // Restore valid size
    pty.resize(80, 24);
    expect(pty.cols).toBe(80);
    expect(pty.rows).toBe(24);

    pty.kill("SIGTERM");
  });
});

describe("close", () => {
  it("should clean up resources", async () => {
    const exe = isWindows ? "cmd.exe" : "/bin/cat";
    const pty = spawn(exe);

    expect(pty.pid).toBeGreaterThan(0);

    pty.close();

    // Should be safe to call multiple times
    pty.close();

    // write/resize should be no-ops after close
    pty.write("should not throw");
    pty.resize(80, 24);
  });

  it("should trigger onExit after close kills process", async () => {
    const exe = isWindows ? "cmd.exe" : "/bin/cat";
    const pty = spawn(exe);

    const exitInfo = await new Promise<{ exitCode: number; signal: number }>((resolve) => {
      pty.onExit(resolve);
      setTimeout(() => pty.close(), 100);
      setTimeout(() => resolve({ exitCode: -999, signal: -999 }), 5000);
    });

    // Process should have been killed
    expect(exitInfo.exitCode).not.toBe(-999);
  });
});

describeUnix("flow control (unix)", () => {
  it("should intercept default XOFF/XON when handleFlowControl is true", async () => {
    const pty = spawn("/bin/cat", [], { handleFlowControl: true });

    const received: string[] = [];
    pty.onData((data) => {
      if (typeof data === "string") received.push(data);
    });

    setTimeout(() => {
      pty.write("\x13"); // XOFF - should be intercepted
      pty.write("visible\n");
      pty.write("\x11"); // XON - should be intercepted
    }, 100);

    await new Promise((r) => setTimeout(r, 500));

    const all = received.join("");
    expect(all).toContain("visible");

    pty.kill("SIGTERM");
  });

  it("should accept custom flow control characters", () => {
    const pty = spawn("/bin/sh", [], {
      handleFlowControl: true,
      flowControlPause: "\x01",
      flowControlResume: "\x02",
    });

    expect(pty.handleFlowControl).toBe(true);

    pty.kill("SIGTERM");
  });

  it("should not intercept flow control when disabled", async () => {
    const pty = spawn("/bin/cat", [], { handleFlowControl: false });

    const received: (string | Buffer)[] = [];
    pty.onData((data) => received.push(data));

    setTimeout(() => pty.write("hello\n"), 100);

    await new Promise((r) => setTimeout(r, 300));

    const all = received.join("");
    expect(all).toContain("hello");

    pty.kill("SIGTERM");
  });
});

describeUnix("env sanitization (unix)", () => {
  it("should strip TMUX and related vars", async () => {
    const pty = spawn(
      "/bin/sh",
      ["-c", 'sleep 0.05 && echo TMUX=\\"$TMUX\\" COLUMNS=\\"$COLUMNS\\"'],
      {
        env: {
          ...process.env,
          TMUX: "should-be-stripped",
          COLUMNS: "should-be-stripped",
          PATH: process.env.PATH!,
        } as Record<string, string>,
      },
    );

    const output = await new Promise<string>((resolve) => {
      let data = "";
      pty.onData((chunk) => {
        data += chunk;
        if (data.includes("COLUMNS=")) resolve(data);
      });
      setTimeout(() => resolve(data), 5000);
    });

    expect(output).toContain('TMUX=""');
    expect(output).not.toContain("should-be-stripped");
  });

  it("should set TERM from name option", async () => {
    const pty = spawn("/bin/sh", ["-c", "sleep 0.05 && echo $TERM"], {
      name: "xterm-256color",
      env: { PATH: process.env.PATH! },
    });

    const output = await new Promise<string>((resolve) => {
      let data = "";
      pty.onData((chunk) => {
        data += chunk;
        if (data.includes("xterm")) resolve(data);
      });
      setTimeout(() => resolve(data), 5000);
    });

    expect(output).toContain("xterm-256color");
  });
});

describeUnix("spawn with default shell (unix)", () => {
  it("should use SHELL env var when file is omitted", async () => {
    const pty = spawn(undefined, ["-c", "echo default-shell"]);
    expect(pty.pid).toBeGreaterThan(0);

    const output = await new Promise<string>((resolve) => {
      let data = "";
      pty.onData((chunk) => {
        data += typeof chunk === "string" ? chunk : chunk.toString();
        if (data.includes("default-shell")) resolve(data);
      });
      setTimeout(() => resolve(data), 3000);
    });

    expect(output).toContain("default-shell");
  });
});

describeUnix("pause/resume (unix)", () => {
  it("should pause and resume output", async () => {
    const pty = spawn("/bin/cat");

    pty.pause();
    pty.resume();

    pty.kill("SIGTERM");
  });
});

describeUnix("clear (unix)", () => {
  it("should be a no-op on unix", () => {
    const pty = spawn("/bin/sh");
    pty.clear(); // should not throw
    pty.kill("SIGTERM");
  });
});

describeUnix("onData/onExit dispose (unix)", () => {
  it("should stop receiving data after dispose", async () => {
    const pty = spawn("/bin/cat");

    const received: string[] = [];
    const disposable = pty.onData((data) => {
      if (typeof data === "string") received.push(data);
    });

    setTimeout(() => pty.write("before\n"), 100);
    await new Promise((r) => setTimeout(r, 300));

    disposable.dispose();

    setTimeout(() => pty.write("after\n"), 100);
    await new Promise((r) => setTimeout(r, 300));

    const all = received.join("");
    expect(all).toContain("before");

    pty.kill("SIGTERM");
  });
});
