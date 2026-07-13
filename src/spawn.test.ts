import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { open, spawn } from "./index.ts";

const execFileP = promisify(execFile);
const nodeExecutable = "bun" in process.versions ? "node" : process.execPath;

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

  it("delivers concurrent fast-exit output before exited resolves", async () => {
    const modes = ["onData", "terminal"] as const;
    const results = await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        const mode = modes[index % modes.length]!;
        let output = "";
        const pty = spawn(
          process.execPath,
          ["-e", 'process.stdout.write("FAST")'],
          mode === "terminal"
            ? {
                terminal: {
                  data(_terminal, data) {
                    output += Buffer.from(data).toString();
                  },
                },
              }
            : undefined,
        );

        if (mode === "onData") {
          pty.onData((data) => {
            output += data;
          });
        }

        await pty.exited;
        return { mode, output };
      }),
    );

    expect(results.filter(({ output }) => !output.includes("FAST"))).toEqual([]);
  });

  // Regression for #4: the exit callback must keep the event loop alive on its
  // own. If the tsfn is unref'd, Node fires beforeExit and shuts down before
  // the exit-monitor thread can dispatch the callback. Bypasses the TS layer
  // and drives the native binding directly so the test doesn't depend on
  // dist/ or a TS loader being available in the subprocess.
  it.skipIf(isWindows)("native callback delivers output before exit and stays alive", async () => {
    const prebuildsDir = path.resolve(__dirname, "..", "prebuilds");
    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      const dir = ${JSON.stringify(prebuildsDir)};
      const base = "zigpty." + process.platform + "-" + process.arch;
      let native;
      try { native = require(path.join(dir, base + ".node")); }
      catch { native = require(path.join(dir, base + "-musl.node")); }
      let output = "";
      const result = native.fork("/bin/sh", ["-c", "printf RAW"], [], process.cwd(), 80, 24, -1, -1, true, (event) => {
        if (Buffer.isBuffer(event)) {
          output += event;
          return;
        }
        fs.closeSync(result.fd);
        process.stdout.write(output + "|EXITED:" + event.exitCode);
      });
    `;
    const { stdout } = await execFileP(nodeExecutable, ["-e", script], { timeout: 10_000 });
    expect(stdout).toBe("RAW|EXITED:0");
  });

  it.skipIf(isWindows)("native exit cleanup cannot close a recycled public fd", async () => {
    const prebuildsDir = path.resolve(__dirname, "..", "prebuilds");
    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      const dir = ${JSON.stringify(prebuildsDir)};
      const base = "zigpty." + process.platform + "-" + process.arch;
      let native;
      try { native = require(path.join(dir, base + ".node")); }
      catch { native = require(path.join(dir, base + "-musl.node")); }
      let result;
      result = native.fork("/bin/true", [], [], process.cwd(), 80, 24, -1, -1, true, (event) => {
        if (Buffer.isBuffer(event)) return;
        fs.closeSync(result.fd);
        const replacement = fs.openSync("/dev/null", "r");
        const reused = replacement === result.fd;
        setImmediate(() => {
          let valid = true;
          try { fs.fstatSync(replacement); } catch { valid = false; }
          if (valid) fs.closeSync(replacement);
          process.stdout.write(JSON.stringify({ reused, valid }));
        });
      });
    `;
    const { stdout } = await execFileP(nodeExecutable, ["-e", script], { timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual({ reused: true, valid: true });
  });

  it.skipIf(isWindows)("native close drops queued data callbacks", async () => {
    const prebuildsDir = path.resolve(__dirname, "..", "prebuilds");
    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      const dir = ${JSON.stringify(prebuildsDir)};
      const base = "zigpty." + process.platform + "-" + process.arch;
      let native;
      try { native = require(path.join(dir, base + ".node")); }
      catch { native = require(path.join(dir, base + "-musl.node")); }
      let result;
      let closed = false;
      let callbacksAfterClose = 0;
      result = native.fork(
        process.execPath,
        ["-e", 'require("node:fs").writeSync(1, "x".repeat(1_000_000)); setInterval(() => {}, 1000)'],
        Object.entries(process.env).map(([key, value]) => key + "=" + value),
        process.cwd(), 80, 24, -1, -1, true,
        (event) => {
          if (Buffer.isBuffer(event)) {
            if (!closed) {
              closed = true;
              native.close(result.handle);
            } else {
              callbacksAfterClose += 1;
            }
            return;
          }
          fs.closeSync(result.fd);
          process.stdout.write(String(callbacksAfterClose));
        },
      );
    `;
    const { stdout } = await execFileP(nodeExecutable, ["-e", script], { timeout: 10_000 });
    expect(stdout).toBe("0");
  });

  it.skipIf(isWindows)("native fork failures close the master fd", async () => {
    const prebuildsDir = path.resolve(__dirname, "..", "prebuilds");
    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      const tty = require("node:tty");
      const dir = ${JSON.stringify(prebuildsDir)};
      const base = "zigpty." + process.platform + "-" + process.arch;
      let native;
      try { native = require(path.join(dir, base + ".node")); }
      catch { native = require(path.join(dir, base + "-musl.node")); }
      const fdDirectory = process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd";
      const countPtys = () => fs.readdirSync(fdDirectory)
        .filter((fd) => tty.isatty(Number(fd))).length;
      try {
        native.fork("/bin/true", [], [], process.cwd(), 80, 24, -1, -1, true, {});
      } catch {}
      const before = countPtys();
      let throws = 0;
      for (let index = 0; index < 20; index += 1) {
        try {
          native.fork("/bin/true", [], [], process.cwd(), 80, 24, -1, -1, true, {});
        } catch {
          throws += 1;
        }
      }
      process.stdout.write(JSON.stringify({ leaked: countPtys() - before, throws }));
    `;
    const { stdout } = await execFileP(nodeExecutable, ["-e", script], { timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual({ leaked: 0, throws: 20 });
  });

  it.skipIf(isWindows)("completed native PTYs release fds and active threads", async () => {
    const prebuildsDir = path.resolve(__dirname, "..", "prebuilds");
    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      const { execFileSync } = require("node:child_process");
      const dir = ${JSON.stringify(prebuildsDir)};
      const base = "zigpty." + process.platform + "-" + process.arch;
      let native;
      try { native = require(path.join(dir, base + ".node")); }
      catch { native = require(path.join(dir, base + "-musl.node")); }
      const fdDirectory = process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd";
      const threadCount = () => {
        if (process.platform === "linux") {
          return Number(fs.readFileSync("/proc/self/status", "utf8").match(/^Threads:\\s+(\\d+)$/m)[1]);
        }
        return execFileSync("ps", ["-M", "-p", String(process.pid)], { encoding: "utf8" })
          .trim().split("\\n").length - 1;
      };
      const before = { fds: fs.readdirSync(fdDirectory).length, threads: threadCount() };
      const run = () => new Promise((resolve) => {
        const result = native.fork("/bin/true", [], [], process.cwd(), 80, 24, -1, -1, true, (event) => {
          if (!Buffer.isBuffer(event)) {
            fs.closeSync(result.fd);
            void result.handle;
            resolve();
          }
        });
      });
      (async () => {
        for (let index = 0; index < 100; index += 1) await run();
        global.gc();
        const after = { fds: fs.readdirSync(fdDirectory).length, threads: threadCount() };
        process.stdout.write(JSON.stringify({
          fds: after.fds - before.fds,
          threads: after.threads - before.threads,
        }));
      })();
    `;
    const { stdout } = await execFileP(nodeExecutable, ["--expose-gc", "-e", script], {
      timeout: 20_000,
    });
    expect(JSON.parse(stdout)).toEqual({ fds: 0, threads: 0 });
  });

  it.skipIf(isWindows)(
    "terminating a Worker cleans up its PTY child and native lifecycle",
    async () => {
      const moduleUrl = new URL("./index.ts", import.meta.url).href;
      const script = `
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const { Worker } = require("node:worker_threads");
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zigpty-worker-"));
      const pidFile = path.join(directory, "child.pid");
      let worker;
      let childPid;
      let replacement;
      const readChildPid = () => {
        if (childPid) return childPid;
        try { return Number(fs.readFileSync(pidFile, "utf8")); }
        catch { return undefined; }
      };
      const killChild = () => {
        const pid = readChildPid();
        if (!pid) return;
        try { process.kill(pid, "SIGKILL"); } catch {}
      };
      const guard = setTimeout(() => {
        killChild();
        process.stderr.write("Worker teardown timed out");
        process.exit(2);
      }, 5000);

      (async () => {
        try {
          worker = new Worker(
            'const fs = require("node:fs");' +
            'const { parentPort, workerData } = require("node:worker_threads");' +
            '(async () => {' +
            '  const { spawn } = await import(workerData.moduleUrl);' +
            '  const pty = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);' +
            '  const fd = pty._fd;' +
            '  fs.closeSync(fd);' +
            '  fs.writeFileSync(workerData.pidFile, String(pty.pid));' +
            '  parentPort.postMessage({ pid: pty.pid, fd });' +
            '})();',
            {
              eval: true,
              execArgv: [],
              workerData: { moduleUrl: ${JSON.stringify(moduleUrl)}, pidFile },
            },
          );
          const child = await new Promise((resolve, reject) => {
            worker.once("message", resolve);
            worker.once("error", reject);
            worker.once("exit", (code) => {
              if (code !== 0) reject(new Error("Worker exited before reporting its child"));
            });
          });
          childPid = child.pid;
          replacement = fs.openSync("/dev/null", "r");
          if (replacement !== child.fd) throw new Error("Worker PTY fd was not reused");
          await worker.terminate();
          fs.fstatSync(replacement);
          let childAlive = true;
          try { process.kill(childPid, 0); } catch { childAlive = false; }
          if (childAlive) throw new Error("PTY child survived Worker termination");
          clearTimeout(guard);
          process.stdout.write("CLEAN");
        } finally {
          killChild();
          if (replacement !== undefined) {
            try { fs.closeSync(replacement); } catch {}
          }
          fs.rmSync(directory, { recursive: true, force: true });
        }
      })().catch((error) => {
        process.stderr.write(error.stack || String(error));
        process.exitCode = 1;
      });
    `;
      const { stdout } = await execFileP(nodeExecutable, ["-e", script], { timeout: 10_000 });
      expect(stdout).toBe("CLEAN");
    },
  );

  it.skipIf(isWindows)(
    "Worker cleanup after child reap finishes without stale signaling",
    async () => {
      const moduleUrl = new URL("./index.ts", import.meta.url).href;
      const script = `
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const { Worker } = require("node:worker_threads");
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zigpty-worker-reaped-"));
      const pidFile = path.join(directory, "child.pid");
      let childPid;
      let publicFd;
      const killChild = () => {
        if (!childPid) {
          try { childPid = Number(fs.readFileSync(pidFile, "utf8")); } catch {}
        }
        if (childPid) {
          try { process.kill(childPid, "SIGKILL"); } catch {}
        }
      };
      const guard = setTimeout(() => {
        killChild();
        process.stderr.write("Reaped Worker teardown timed out");
        process.exit(2);
      }, 5000);

      (async () => {
        try {
          const worker = new Worker(
            'const fs = require("node:fs");' +
            'const { parentPort, workerData } = require("node:worker_threads");' +
            '(async () => {' +
            '  const { spawn } = await import(workerData.moduleUrl);' +
            '  const pty = spawn(process.execPath, ["-e", workerData.childScript]);' +
            '  const stat = fs.fstatSync(pty._fd);' +
            '  fs.writeFileSync(workerData.pidFile, String(pty.pid));' +
            '  parentPort.postMessage({' +
            '    pid: pty.pid, fd: pty._fd,' +
            '    identity: [stat.dev, stat.ino, stat.rdev, stat.mode],' +
            '  });' +
            '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);' +
            '})();',
            {
              eval: true,
              execArgv: [],
              workerData: {
                moduleUrl: ${JSON.stringify(moduleUrl)},
                pidFile,
                childScript: 'require("node:fs").writeSync(1, "x".repeat(4_000))',
              },
            },
          );
          const child = await new Promise((resolve, reject) => {
            worker.once("message", resolve);
            worker.once("error", reject);
          });
          childPid = child.pid;
          publicFd = child.fd;
          while (true) {
            try {
              process.kill(childPid, 0);
              await new Promise(setImmediate);
            } catch {
              break;
            }
          }
          await worker.terminate();
          let samePty = false;
          try {
            const stat = fs.fstatSync(publicFd);
            samePty = [stat.dev, stat.ino, stat.rdev, stat.mode]
              .every((value, index) => value === child.identity[index]);
          } catch {}
          if (samePty) throw new Error("Worker PTY fd survived environment cleanup");
          clearTimeout(guard);
          process.stdout.write("CLEAN");
        } finally {
          killChild();
          fs.rmSync(directory, { recursive: true, force: true });
        }
      })().catch((error) => {
        process.stderr.write(error.stack || String(error));
        process.exitCode = 1;
      });
    `;
      const { stdout } = await execFileP(nodeExecutable, ["-e", script], { timeout: 10_000 });
      expect(stdout).toBe("CLEAN");
    },
  );

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

  it.skipIf(isWindows)("should track descendants in a different process group", async () => {
    // Regression test for the pivot from foreground-pgrp aggregation to a
    // ppid descendant tree. `child_process.spawn(..., { detached: true })`
    // calls setsid() in the child, placing it in its own session/pgrp. The
    // old pgrp-based code would have missed this child entirely; the new
    // ppid-based BFS still finds it because ppid still points at the leader.
    const script =
      "const cp = require('node:child_process');" +
      "cp.spawn('/bin/sleep', ['5'], { detached: true, stdio: 'ignore' }).unref();" +
      "setTimeout(() => {}, 4000);";
    const pty = spawn(process.execPath, ["-e", script]);

    // macOS reports `/bin/sleep` as `gsleep` (Apple's g-prefixed comm); match
    // both with `includes("sleep")`.
    const stats = await pollStats(
      pty,
      (s) => s.children.some((c) => c.name.includes("sleep")),
      8000,
    );
    const detached = stats.children.find((c) => c.name.includes("sleep"));
    expect(detached).toBeDefined();
    expect(detached!.pid).toBeGreaterThan(0);

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

  it.each(["onData", "terminal"] as const)(
    "should suppress %s callbacks after close and release the fd",
    async (mode) => {
      let pty: ReturnType<typeof spawn>;
      let closeTriggered = false;
      let callbacksAfterClose = 0;
      const onData = (data: string | Uint8Array) => {
        const output = typeof data === "string" ? data : Buffer.from(data).toString();
        if (!output.includes("x")) return;
        if (closeTriggered) {
          callbacksAfterClose += 1;
          return;
        }
        closeTriggered = true;
        pty.close();
      };
      pty = spawn(
        process.execPath,
        [
          "-e",
          `
            const fs = require("node:fs");
            process.stdout.write("READY");
            process.stdin.once("data", () => {
              fs.writeSync(1, "x".repeat(1_000_000));
              process.exit(0);
            });
          `,
        ],
        mode === "terminal"
          ? {
              terminal: {
                data(_terminal, data) {
                  onData(data);
                },
              },
            }
          : undefined,
      );

      if (mode === "onData") {
        pty.onData(onData);
      }

      await pty.waitFor("READY");
      const fd = (pty as unknown as { _fd: number })._fd;
      const pid = pty.pid;
      pty.write("go\n");
      await pty.exited;

      expect(closeTriggered).toBe(true);
      expect(callbacksAfterClose).toBe(0);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(() => fs.fstatSync(fd)).toThrow();
    },
  );

  it.skipIf(isWindows)("should dispose a child that ignores SIGHUP", async () => {
    let fd = -1;
    let pid = -1;
    let exitInfo: { exitCode: number; signal: number } | undefined;

    {
      await using pty = spawn(process.execPath, [
        "-e",
        `
          process.on("SIGHUP", () => {});
          process.stdout.write("READY");
          setInterval(() => {}, 1000);
        `,
      ]);
      await pty.waitFor("READY");
      fd = (pty as unknown as { _fd: number })._fd;
      pid = pty.pid;
      pty.onExit((info) => {
        exitInfo = info;
      });
    }

    expect(exitInfo).toEqual({ exitCode: 0, signal: 9 });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => fs.fstatSync(fd)).toThrow();
  });

  it.skipIf(isWindows)("should stop public data callbacks when terminal data closes", async () => {
    let pty: ReturnType<typeof spawn>;
    let publicCallbacks = 0;
    pty = spawn(
      process.execPath,
      ["-e", 'process.stdout.write("CLOSE"); setInterval(() => {}, 1000)'],
      {
        terminal: {
          data(_terminal, data) {
            if (Buffer.from(data).includes(0x43)) pty.close();
          },
        },
      },
    );
    pty.onData((data) => {
      if (Buffer.from(data).includes(0x43)) publicCallbacks += 1;
    });

    await pty.exited;
    expect(publicCallbacks).toBe(0);
  });

  it.skipIf(isWindows)(
    "should terminate inheriting descendants when the leader exits first",
    async () => {
      const childScript = `
      process.on("SIGHUP", () => {});
      process.send("ready");
      process.disconnect();
      setInterval(() => {}, 1000);
    `;
      const leaderScript = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], {
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });
      child.on("message", () => {
        process.stdout.write("DESC:" + child.pid + "\\n");
        child.unref();
      });
    `;
      const pty = spawn(process.execPath, ["-e", leaderScript]);
      let descendant = -1;

      try {
        const output = await pty.waitFor("\n");
        descendant = Number(output.match(/DESC:(\d+)/)?.[1]);
        expect(descendant).toBeGreaterThan(0);

        while (true) {
          try {
            process.kill(pty.pid, 0);
            await setImmediate();
          } catch {
            break;
          }
        }
        pty.close();
        await pty.exited;
        while (true) {
          try {
            process.kill(descendant, 0);
            await setImmediate();
          } catch {
            break;
          }
        }
        expect(() => process.kill(descendant, 0)).toThrow();
      } finally {
        pty.close();
        if (descendant > 0) {
          try {
            process.kill(descendant, "SIGKILL");
          } catch {}
        }
        await pty.exited;
      }
    },
  );

  it.skipIf(isWindows)(
    "should release the PTY while leaving detached descendants outside its group",
    async () => {
      const leaderScript = `
      const { spawn } = require("node:child_process");
      const child = spawn(
        process.execPath,
        ["-e", 'process.on("SIGHUP", () => {}); setInterval(() => {}, 1000)'],
        { detached: true, stdio: "inherit" },
      );
      process.stdout.write("DESC:" + child.pid + "\\n");
      setInterval(() => {}, 1000);
    `;
      const pty = spawn(process.execPath, ["-e", leaderScript]);
      let descendant = -1;

      try {
        const output = await pty.waitFor("\n");
        descendant = Number(output.match(/DESC:(\d+)/)?.[1]);
        expect(descendant).toBeGreaterThan(0);

        pty.close();
        await pty.exited;
        expect(() => process.kill(descendant, 0)).not.toThrow();
      } finally {
        pty.close();
        if (descendant > 0) {
          try {
            process.kill(descendant, "SIGKILL");
          } catch {}
          while (true) {
            try {
              process.kill(descendant, 0);
              await setImmediate();
            } catch {
              break;
            }
          }
        }
        await pty.exited;
      }
    },
  );
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

  it("should apply backpressure to substantial output while paused", async () => {
    const directory = await fsPromises.mkdtemp(path.join(tmpdir(), "zigpty-pause-"));
    const marker = path.join(directory, "writing");
    const doneMarker = path.join(directory, "done");
    let outputBytes = 0;
    const pty = spawn(
      process.execPath,
      [
        "-e",
        `
          const fs = require("node:fs");
          process.stdout.write("READY");
          process.stdin.once("data", () => {
            fs.writeSync(1, "x".repeat(60_000));
            fs.writeFileSync(${JSON.stringify(marker)}, "writing");
            fs.writeSync(1, "x".repeat(940_000));
            fs.writeFileSync(${JSON.stringify(doneMarker)}, "done");
            process.exit(0);
          });
        `,
      ],
      { encoding: null },
    );
    pty.onData((data) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      for (const byte of buffer) {
        if (byte === 0x78) outputBytes += 1;
      }
    });

    try {
      await pty.waitFor("READY");
      pty.pause();
      pty.write("go\n");

      while (true) {
        try {
          await fsPromises.readFile(marker);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await setImmediate();
        }
      }

      expect(pty.stats()).not.toBeNull();
      expect(outputBytes).toBeLessThan(1_000_000);
      await expect(fsPromises.readFile(doneMarker)).rejects.toMatchObject({ code: "ENOENT" });

      pty.resume();
      await pty.exited;
      expect(outputBytes).toBe(1_000_000);
      await expect(fsPromises.readFile(doneMarker, "utf8")).resolves.toBe("done");
    } finally {
      pty.kill("SIGKILL");
      await pty.exited;
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  });

  it("should deliver remaining output and exit while paused", async () => {
    let output = "";
    const pty = spawn(process.execPath, [
      "-e",
      `
        const fs = require("node:fs");
        process.stdout.write("READY");
        process.stdin.once("data", () => {
          fs.writeSync(1, "DONE");
          process.exit(0);
        });
      `,
    ]);
    pty.onData((data) => {
      output += data;
    });
    const exitInfo = new Promise<{ exitCode: number; signal: number }>((resolve) => {
      pty.onExit(resolve);
    });

    await pty.waitFor("READY");
    pty.pause();
    pty.write("go\n");

    await expect(pty.exited).resolves.toBe(0);
    await expect(exitInfo).resolves.toEqual({ exitCode: 0, signal: 0 });
    expect(output).toContain("DONE");
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
