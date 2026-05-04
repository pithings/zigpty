# zigpty

Tiny, cross-platform PTY library for Node.js, built in Zig, also usable as a standalone Zig package. Supports Linux, macOS, Android and Windows (via ConPTY).

Drop-in replacement for [`node-pty`](https://github.com/microsoft/node-pty). **350x smaller** (43 KB vs 15.5 MB packed, 176 KB vs 64.4 MB installed), no `node-gyp` or C++ compiler needed, and ships musl prebuilds for Alpine.

## Use cases

Regular `child_process.spawn()` runs programs without a terminal attached. That means no colors, no cursor control, no prompts — programs like `vim`, `top`, `htop`, or interactive shells simply don't work. A **PTY** (pseudo-terminal) makes the subprocess think it's connected to a real terminal. Colors, line editing, full-screen TUIs, and terminal resizing all work as expected.

- **Terminal emulators** — embed a terminal in Electron, Tauri, or a web app
- **Remote shells** — stream a PTY over WebSocket from a Node.js server
- **CI / automation** — run programs that require a TTY (interactive installers, REPLs)
- **Testing** — test CLI tools that use colors, prompts, or cursor movement
- **AI agents** — give LLM agents a real shell to run commands, observe output, and interact with CLIs

## Usage

```ts
import { spawn } from "zigpty";

// auto-detects default shell ($SHELL on Unix, %COMSPEC% on Windows)
const pty = spawn(undefined, [], {
  cols: 80,
  rows: 24,
  terminal: {
    data(terminal, data: Uint8Array) {
      process.stdout.write(data);
    },
  },
  onExit(exitCode, signal) {
    console.log("exited:", exitCode);
  },
});

pty.write("echo hello\n");
pty.resize(120, 40);
await pty.exited; // Promise<number>
```

Terminal callbacks bypass Node.js streams and deliver raw `Uint8Array` directly from native code. You can also use the `onData`/`onExit` event listeners instead:

```ts
pty.onData((data) => process.stdout.write(data));
pty.onExit(({ exitCode }) => console.log("exited:", exitCode));
```

The `Terminal` class can be reused across multiple spawns and supports `AsyncDisposable`:

```ts
import { spawn, Terminal } from "zigpty";

await using terminal = new Terminal({
  data(term, data) {
    process.stdout.write(data);
  },
});

const pty = spawn("/bin/sh", ["-c", "echo hello"], { terminal });
await pty.exited;
// terminal.close() called automatically by `await using`
```

## API

### `spawn(file, args?, options?)`

Spawn a process inside a new PTY.

**Options:**

```ts
interface IPtyOptions {
  cols?: number; // Default: 80
  rows?: number; // Default: 24
  cwd?: string; // Default: process.cwd()
  env?: Record<string, string>; // Default: process.env
  name?: string; // Sets TERM (e.g. "xterm-256color")
  encoding?: BufferEncoding | null; // Default: "utf8", null for raw Buffer
  uid?: number; // Unix user ID
  gid?: number; // Unix group ID
  handleFlowControl?: boolean; // Intercept XON/XOFF (default: false)
  pipe?: boolean; // Force pipe-based fallback (default: false)
  terminal?: TerminalOptions | Terminal; // Bun-compatible terminal callbacks
  onExit?: (exitCode: number, signal: number) => void;
}
```

**Returns:**

```ts
interface IPty {
  pid: number;
  cols: number;
  rows: number;
  readonly process: string; // Foreground process name
  readonly exited: Promise<number>; // Resolves with exit code
  readonly exitCode: number | null; // Exit code or null if running

  onData: (cb: (data: string | Buffer) => void) => IDisposable;
  onExit: (cb: (e: { exitCode: number; signal: number }) => void) => IDisposable;

  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void; // Default: SIGHUP
  pause(): void;
  resume(): void;
  close(): void;
  waitFor(pattern: string, options?: { timeout?: number }): Promise<string>;
  stats(): IPtyStats | null; // OS-level snapshot (cwd, memory, CPU time)
}
```

### `pty.stats()`

Snapshot OS-level process info aggregated across the spawned process and **every transitive descendant** (BFS by ppid). If you spawn `bash`, the totals cover bash + every command, subshell, background job, pipeline, and grandchild it spawned. `rssBytes`, `cpuUser`, and `cpuSys` are **totals** summed over the leader and every tracked descendant. `count` is how many processes were rolled into the totals. `children[]` lists each non-leader descendant (`{pid, name, rssBytes, cpuUser, cpuSys}`) so you can see the breakdown.

The same descendant-tree model applies on every platform — pgrp/session/job-control juggling doesn't matter, since the walk follows ppid edges. The only thing not tracked is **double-fork daemons** (`nohup`, `setsid` + intermediate exit) that explicitly reparent away to init/launchd.

```ts
const pty = spawn("/bin/bash");
// …user types `cd /tmp && cargo build`…
const s = pty.stats();
// {
//   pid: 4821,               // leader (the spawned shell)
//   cwd: "/tmp",             // leader's cwd; null on Windows
//   rssBytes: 2_147_483_648, // total across leader + descendants
//   cpuUser: 8_430_000,      // microseconds
//   cpuSys: 1_250_000,
//   count: 17,               // leader + 16 descendants
//   children: [
//     { pid: 4822, name: "cargo",   rssBytes: 128_000_000, cpuUser: 500_000, cpuSys: 80_000 },
//     { pid: 4823, name: "rustc",   rssBytes: 512_000_000, cpuUser: 2_000_000, cpuSys: 300_000 },
//     // …14 more…
//   ],
// }
```

Returns `null` when stats can't be read (process exited, PTY closed, or running in pipe fallback on non-Linux). Polling is on-demand — no background thread, no cost when unused.

### `pty.waitFor(pattern, options?)`

Wait until the PTY output contains the given string. Returns all output collected so far. Useful for AI agents that need to read prompts before responding.

```ts
import { spawn, Terminal } from "zigpty";

// Terminal provides callback-based data handling and AsyncDisposable cleanup
await using terminal = new Terminal({
  cols: 100,
  rows: 30,
  // Nice to meet you, zigpty! Zig is a great choice!
  data: (_terminal, data) => process.stdout.write(data),
});

// spawn() attaches to the Terminal — data flows through terminal callbacks
const pty = spawn(
  "python3",
  [
    "-c",
    `
name = input("What is your name? ")
lang = input("Favorite language? ")
print(f"Nice to meet you, {name}! {lang} is a great choice!")
`,
  ],
  { terminal },
);

// waitFor() resolves when the output contains the pattern
await pty.waitFor("name?");
pty.write("zigpty\n");

await pty.waitFor("language?");
pty.write("Zig\n");

// exited returns a Promise<number> with the exit code
await pty.exited;
```

Options: `{ timeout?: number }` — default 30 seconds. Throws if the pattern is not found within the timeout.

### `hasNative`

Boolean — `true` when native Zig PTY bindings loaded successfully, `false` when running in pipe fallback mode.

### `open(options?)`

Create a PTY pair without spawning a process — useful when you need to control the child process yourself.

```ts
import { open } from "zigpty";

const { master, slave, pty } = open({ cols: 80, rows: 24 });
```

## Pipe fallback

When native Zig PTY bindings can't load (missing prebuilds, sandboxed containers, WASM, minimal libc), `spawn()` automatically falls back to a pure-TypeScript pipe-based PTY instead of crashing. This covers containers without `/dev/ptmx`, CI environments without prebuilds, and restricted runtimes.

You can also force the pipe fallback explicitly with the `pipe` option:

```ts
import { spawn, hasNative } from "zigpty";

// Automatic — uses native if available, pipes otherwise
const pty = spawn("ls", ["-la"]);

// Explicit — force pipe mode even when native is available
const pty = spawn("ls", ["-la"], { pipe: true });
```

You can also use `PipePty` directly:

```ts
import { PipePty } from "zigpty";

const pty = new PipePty("/bin/sh", ["-c", "echo hello"]);
```

The pipe fallback emulates terminal behavior where possible:

- **Signal translation** — `^C`→SIGINT, `^Z`→SIGTSTP, `^\`→SIGQUIT, `^D`→EOF
- **Line discipline** — canonical mode with echo, backspace, `^W` word erase, `^U` line kill
- **Flow control** — XON/XOFF interception (when `handleFlowControl` is enabled)
- **Force-color hints** — auto-sets `FORCE_COLOR=1` and `COLORTERM=truecolor`
- **Resize** — sends `SIGWINCH` to the child process as a best-effort hint
- **Process tracking** — reads foreground process name from `/proc` on Linux

Raw mode (no echo, no line buffering) is available via `setRawMode()` / `setCanonicalMode()` on `PipePty` instances.

**Known limitations** — programs see `isatty()` → false, no kernel-level TIOCSWINSZ, `open()` throws in fallback mode.

## Platform support

| Platform            | Status |
| ------------------- | ------ |
| Linux x64 (glibc)   | ✅     |
| Linux x64 (musl)    | ✅     |
| Linux arm64 (glibc) | ✅     |
| Linux arm64 (musl)  | ✅     |
| macOS x64           | ✅     |
| macOS arm64         | ✅     |
| Windows x64         | ✅     |
| Windows arm64       | ✅     |

All 8 platform binaries are prebuilt — no compiler needed at install time. On Linux, the native loader tries glibc first and falls back to musl automatically.

## Zig package

The PTY core is a standalone Zig package with no Node.js or NAPI dependency.

```sh
zig fetch --save git+https://github.com/pithings/zigpty.git
```

Wire it up in `build.zig`:

```zig
const zigpty = b.dependency("zigpty", .{ .target = target, .optimize = optimize });
exe.root_module.addImport("zigpty", zigpty.module("zigpty"));
```

API:

```zig
const pty = @import("zigpty");

// Fork a process with a PTY
const result = try pty.forkPty(.{
    .file = "/bin/bash",
    .argv = &.{ "/bin/bash", null },
    .envp = &.{ "TERM=xterm-256color", null },
    .cwd = "/home/user",
    .cols = 120,
    .rows = 40,
});
// result.fd  — PTY file descriptor (read/write)
// result.pid — child process ID

// Open a bare PTY pair (no process spawned)
const pair = try pty.openPty(80, 24);
// pair.master, pair.slave

// Resize
try pty.resize(result.fd, 80, 24, 0, 0);

// Foreground process name
var buf: [4096]u8 = undefined;
const name: ?[]const u8 = pty.getProcessName(result.fd, &buf);

// Block until child exits
const exit_info = pty.waitForExit(result.pid);
// exit_info.exit_code, exit_info.signal_code
```

## Building from source

Requires [Zig](https://ziglang.org/) 0.16.0+.

```sh
zig build              # Build prebuilds (all targets)
zig build --release    # Release build
bun run build          # Build + bundle TypeScript
bun test               # Run tests
```

## Sponsors

<p align="center">
  <a href="https://sponsors.pi0.io/">
    <img src="https://sponsors.pi0.io/sponsors.svg?xyz">
  </a>
</p>

## Credits

API-compatible with [node-pty](https://github.com/microsoft/node-pty). Terminal API inspired by [Bun](https://bun.sh/docs/runtime/child-process#terminal-pty-support).

## License

MIT
