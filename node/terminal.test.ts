import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import { Terminal, spawn } from "./index.ts";

const isWindows = platform() === "win32";
const shell = isWindows ? "cmd.exe" : "/bin/sh";

describe("Terminal", () => {
  it("should create a terminal with default options", () => {
    const terminal = new Terminal();
    expect(terminal.closed).toBe(false);
    if (!isWindows) {
      expect(terminal.stdin).toBeGreaterThan(0);
      expect(terminal.stdout).toBeGreaterThan(0);
    }
    terminal.close();
    expect(terminal.closed).toBe(true);
  });

  it("should create a terminal with custom size", () => {
    const terminal = new Terminal({ cols: 120, rows: 40 });
    expect(terminal.closed).toBe(false);
    terminal.close();
  });

  it("should support AsyncDisposable", async () => {
    let closed = false;
    {
      await using terminal = new Terminal({
        exit() {
          closed = true;
        },
      });
      expect(terminal.closed).toBe(false);
    }
    expect(closed).toBe(true);
  });
});

describe("spawn with terminal option", () => {
  it("should receive data via terminal callback", async () => {
    const cmd = isWindows ? ["/c", "echo hello terminal"] : ["-c", "sleep 0.05 && echo hello terminal"];

    const output = await new Promise<string>((resolve) => {
      let data = "";
      const pty = spawn(shell, cmd, {
        terminal: {
          cols: 80,
          rows: 24,
          data(_terminal, chunk) {
            data += new TextDecoder().decode(chunk);
            if (data.includes("hello terminal")) resolve(data);
          },
        },
      });

      expect(pty.pid).toBeGreaterThan(0);
      setTimeout(() => resolve(data), 5000);
    });

    expect(output).toContain("hello terminal");
  });

  it("should resolve exited promise with exit code", async () => {
    const cmd = isWindows ? ["/c", "exit 42"] : ["-c", "exit 42"];
    const pty = spawn(shell, cmd);

    const exitCode = await pty.exited;
    expect(exitCode).toBe(42);
    expect(pty.exitCode).toBe(42);
  });

  it("should call onExit option callback", async () => {
    const cmd = isWindows ? ["/c", "exit 7"] : ["-c", "exit 7"];

    const exitInfo = await new Promise<{ exitCode: number; signal: number }>((resolve) => {
      spawn(shell, cmd, {
        onExit(exitCode, signal) {
          resolve({ exitCode, signal });
        },
      });
      setTimeout(() => resolve({ exitCode: -1, signal: -1 }), 5000);
    });

    expect(exitInfo.exitCode).toBe(7);
  });

  it("should write data via terminal callback", async () => {
    const exe = isWindows ? "cmd.exe" : "/bin/cat";

    const output = await new Promise<string>((resolve) => {
      let data = "";
      const pty = spawn(exe, [], {
        terminal: {
          data(_terminal, chunk) {
            data += new TextDecoder().decode(chunk);
            if (data.includes("zigpty-test")) resolve(data);
          },
        },
      });

      setTimeout(() => {
        pty.write("zigpty-test\n");
      }, 100);
      setTimeout(() => resolve(data), 5000);
    });

    expect(output).toContain("zigpty-test");
  });

  it("should pass existing Terminal instance", async () => {
    const cmd = isWindows ? ["/c", "echo reuse"] : ["-c", "sleep 0.05 && echo reuse"];

    const output = await new Promise<string>((resolve) => {
      let data = "";
      const terminal = new Terminal({
        cols: 80,
        rows: 24,
        data(_terminal, chunk) {
          data += new TextDecoder().decode(chunk);
          if (data.includes("reuse")) resolve(data);
        },
      });

      const pty = spawn(shell, cmd, { terminal });
      expect(pty.pid).toBeGreaterThan(0);
      setTimeout(() => resolve(data), 5000);
    });

    expect(output).toContain("reuse");
  });

  it("should kill the process", async () => {
    const cmd = isWindows ? [] : ["-c", "sleep 60"];
    const pty = spawn(shell, cmd);

    pty.kill("SIGKILL");
    await pty.exited;
    expect(pty.exitCode).not.toBeNull();
  });
});
