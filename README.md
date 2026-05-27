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

Both `spawn()` and `Terminal` support automatic disposal — `await using` for `spawn()` waits for the process to actually exit, and `using` for `Terminal` closes the PTY synchronously:

```ts
import { spawn, Terminal } from "zigpty";

using terminal = new Terminal({
  data(term, data) {
    process.stdout.write(data);
  },
});

{
  await using pty = spawn("/bin/sh", ["-c", "echo hello"], { terminal });
  // ...do stuff...
} // pty.close() runs; block awaits process exit before continuing
// terminal.close() runs when the outer scope exits
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
  attach(consumer: IPtyConsumer): IDisposable; // Wire a sink to the data stream
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

// Terminal provides callback-based data handling and `using` cleanup
using terminal = new Terminal({
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

### `pty.attach(consumer)`

Wire a generic sink to the PTY's data stream. Anything with a `feed(data)` method conforms to `IPtyConsumer` — including the built-in `OSCInspector`, a file logger, an in-memory recorder, a WebSocket forwarder, etc. The consumer is auto-detached when the PTY exits.

```ts
interface IPtyConsumer {
  feed(data: string | Buffer): void;
  onAttach?(pty: IPty): void; // optional — fires once before the first feed
  onDetach?(pty: IPty): void; // optional — fires on dispose or PTY exit
}
```

```ts
const recorder = {
  chunks: [] as Buffer[],
  feed(data) {
    this.chunks.push(typeof data === "string" ? Buffer.from(data) : data);
  },
};

const sub = pty.attach(recorder);
// ...
sub.dispose(); // detach early; otherwise auto-detached on PTY exit
```

Multiple consumers per PTY are supported and run independently.

### OSC inspector — `zigpty/osc`

Parse OSC (Operating System Command) escape sequences out of any byte stream — title changes, CWD updates, shell-integration marks (OSC 133/633), progress, notifications, and more. The inspector is a pure-TS byte-fed state machine; sequences split across chunks are stitched back together.

```ts
import { spawn } from "zigpty";
import { OSCInspector, decodeOSC } from "zigpty/osc";

const inspector = new OSCInspector((event) => {
  // event = { code: number, payload: string }
  const decoded = decodeOSC(event);
  switch (decoded.kind) {
    case "title":
      console.log("title:", decoded.title);
      break;
    case "cwd":
      // Unified across OSC 7, ConEmu 9;9, and iTerm2 1337;CurrentDir=
      console.log(`cwd (${decoded.source}):`, decoded.path);
      break;
    case "shellIntegration":
      // OSC 133/633 — command is A/B/C/D (or vscode-specific tokens)
      console.log(`${decoded.vendor}/${decoded.command}`, decoded.data);
      break;
    case "notification":
      console.log("notify:", decoded.title, decoded.body);
      break;
    case "progress":
      // ConEmu/Windows Terminal taskbar progress (OSC 9;4)
      console.log(`progress: state=${decoded.state} value=${decoded.value}`);
      break;
    case "mark":
      // OSC 1337 SetMark / OSC 9;12 ConEmu prompt-start mark
      console.log("prompt mark from", decoded.vendor);
      break;
    case "hyperlink":
      console.log(decoded.action, decoded.uri); // "open"|"close"
      break;
    // ...attention, clipboard, userVar, remoteHost,
    // shellIntegrationVersion, unknown
  }
});

const pty = spawn("/bin/bash");
pty.attach(inspector); // OSCInspector implements IPtyConsumer
```

**Stateful inspection** — the inspector maintains an `OSCState` snapshot of the durable, observable state seen so far (title, icon name, cwd, active hyperlink, taskbar progress, remote host, shell-integration version, user vars). State is updated in place before listeners fire, so handlers can read fresh values. Action-like sequences (notifications, marks, clipboard writes, attention requests) don't touch state.

```ts
const inspector = new OSCInspector();
pty.attach(inspector);

inspector.onStateChange((state) => {
  // Fires only on sequences that actually mutated state.
  console.log("title:", state.title);
  console.log("cwd:", state.cwd?.path);
  console.log("progress:", state.progress); // undefined after "remove" (state 0)
  console.log("hyperlink:", state.hyperlink?.uri); // undefined between links
});

// Or pull synchronously at any time:
inspector.state.title; // string | undefined
inspector.state.userVars?.greeting; // base64-decoded SetUserVar values
```

Specifics: OSC 0 sets both `title` and `iconName`; OSC 1 sets `iconName` only; OSC 2 sets `title` only. `cwd` is unified across OSC 7, OSC 1337 `CurrentDir=`, and OSC 9;9 with a `source` discriminator. `hyperlink` is cleared on OSC 8 close (empty URI). `progress` is cleared when state 0 is reported. `dispose()` clears state.

**Decoded shapes** (`DecodedOSC` union) cover the common codes out of the box:

| Code            | `kind`(s)                                                                                         | Notes                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0` / `1` / `2` | `title`                                                                                           | Window / tab / icon title. C0 control bytes stripped.                                                                                                    |
| `7`             | `cwd` (`source: "osc7"`)                                                                          | `<scheme>://<host>/<path>`. Path is percent-decoded; `host`/`scheme`/`local` exposed.                                                                    |
| `8`             | `hyperlink`                                                                                       | `action: "open" \| "close"`; `id`, `uri`, and `params`. Empty URI = close.                                                                               |
| `9`             | `progress` / `cwd` / `mark` / `notification`                                                      | `9;4;…` progress, `9;9;…` ConEmu/WT CWD report, `9;12` prompt mark, `9;<text>` iTerm2 Growl-style notification.                                          |
| `52`            | `clipboard`                                                                                       | Set, query (`?`), or `clear` (Pd not base64). Multi-char `Pc` exposed via `selections[]`.                                                                |
| `99`            | `notification` (`vendor: "kitty"`)                                                                | Title / body / phase (`close`, `alive`, `icon`, …); honors `i=` (id), `u=` (urgency), `d=0` (partial chunk), `e=1` (base64 payload).                     |
| `133`           | `shellIntegration` (`vendor: "vt"`)                                                               | FinalTerm A/B/C/D. `D` parses exit code + `err=`; `A`/`C` parse kitty extras into `params`.                                                              |
| `633`           | `shellIntegration` (`vendor: "vscode"`)                                                           | A/B/C/D/E/P/EnvSingleStart/EnvSingleEntry/EnvSingleEnd. Applies VSCode `\\`/`\xNN` unescaping.                                                           |
| `777`           | `notification` (`vendor: "rxvt"`)                                                                 | `notify;<title>;<body>` from the urxvt-perl extension.                                                                                                   |
| `1337`          | `attention` / `cwd` / `mark` / `userVar` / `remoteHost` / `clipboard` / `shellIntegrationVersion` | iTerm2: `RequestAttention` (`yes`/`no`/`once`/`fireworks`), `CurrentDir=`, `SetMark`, `SetUserVar=`, `RemoteHost=`, `Copy=`, `ShellIntegrationVersion=`. |
| _other_         | `unknown`                                                                                         | Raw `{code, payload}` preserved.                                                                                                                         |

**Adding custom decoders** — use `createOSCDecoder()` to register handlers for new codes (or override built-ins). The returned function is typed as `DecodedOSC | <your custom kinds>`:

```ts
import { createOSCDecoder } from "zigpty/osc";

const decode = createOSCDecoder({
  // OSC 50 — terminal font (xterm), not handled by built-ins
  50: (payload) => ({ kind: "font" as const, value: payload }),
  // OSC 1338 — your custom vendor code
  1338: (payload) => ({ kind: "vendor-x" as const, raw: payload }),
});

const inspector = new OSCInspector((event) => {
  const d = decode(event);
  // d: DecodedOSC | { kind: "font"; ... } | { kind: "vendor-x"; ... }
});
```

The built-in registry is exposed as `builtinOSCDecoders: Record<number, OSCDecoderFn<DecodedOSC>>` if you want to inspect or reuse individual decoders.

### Idle detector — `zigpty/idle`

Implicit terminal-attention detection. Watches the PTY's output stream and emits an `idle` event when a burst of activity stops — typically meaning an interactive agent (Claude Code, aider, a REPL, …) is done streaming and waiting for input. Tuned to suppress the obvious false positives: the startup banner flood, tiny status-bar updates, and pure ANSI redraws.

```ts
import { spawn } from "zigpty";
import { IdleDetector } from "zigpty/idle";

const detector = new IdleDetector((event) => {
  if (event.type === "active") console.log("agent started producing output");
  if (event.type === "idle") console.log("agent likely waiting for input");
});

const pty = spawn("claude", []);
pty.attach(detector); // IdleDetector implements IPtyConsumer
```

How it filters false positives:

| Knob              | Default | What it does                                                                                                                                                                 |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graceMs`         | `1500`  | Significant bytes arriving within this window after `attach` are silently absorbed. Hides the shell-init / prompt-render flood that always happens right when a PTY opens.   |
| `activeThreshold` | `512`   | Minimum significant bytes in a single burst (gaps shorter than `quietMs`) before `active` fires. Status-bar pokes and cursor-blink redraws never accumulate enough to count. |
| `quietMs`         | `750`   | Time with no significant bytes before transitioning `active` → `idle`. Tuned for streaming agents that emit chunks every 50-200ms.                                           |

"Significant bytes" excludes ANSI/CSI/OSC escape sequences and other C0 control characters — only user-visible content counts toward the threshold, so heavily colored output doesn't masquerade as text and a pure spinner redraw contributes very few bytes per cycle.

`IdleDetector` has the same shape as `OSCInspector`: pass a listener (or `.on()` later), `.feed()` raw bytes if you're driving it yourself, and `.dispose()` to clean up. Events carry the burst `bytes` count and transition `durationMs` if you want to introspect output:

```ts
type IdleEvent = {
  type: "active" | "idle";
  bytes: number; // significant bytes accumulated for the output burst
  durationMs: number; // how long the previous state lasted
};
```

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
