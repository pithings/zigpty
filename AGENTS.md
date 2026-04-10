# zigpty

Zig-based PTY library. Dual-use: standalone **Zig package** and **Node.js NAPI addon**.

## Goals

- Smallest build (19KB ReleaseSmall vs node-pty's ~500KB+ with C++ runtime)
- Pure Zig PTY library with no NAPI dependency (`lib.zig`)
- Thin NAPI wrapper layer for Node.js (`pty.zig` + `pty_unix.zig` + `win/napi.zig` + `root.zig`)
- Raw NAPI — no third-party Zig NAPI bindings, no node-gyp
- Cross-platform (Linux + macOS + Windows)
- Statically linked via Zig

## Architecture

```
zigpty/
├── build.zig               # Zig build: exposes "zigpty" module + NAPI shared libs
├── build.zig.zon           # Zig package metadata (min Zig 0.15.1)
├── build.config.ts         # obuild config (bundle src/ → dist/)
├── zig/                    # Zig sources (two layers)
│   ├── lib.zig             # Pure Zig PTY library — platform dispatcher + shared code
│   ├── root.zig            # NAPI module entry: exports platform-specific functions
│   ├── napi.zig            # Raw NAPI bindings (~240 lines, extern declarations)
│   ├── pty.zig             # NAPI shared helpers + platform dispatch (re-exports)
│   ├── pty_unix.zig        # NAPI↔lib.zig bridge for Unix (fork, open, resize, process)
│   ├── termios.zig         # Default terminal config (Linux + macOS)
│   ├── pty_linux.zig       # Linux-specific: execvpe, ptsname_r, /proc, close_range
│   ├── pty_darwin.zig      # macOS-specific: execvp+environ, sysctl, FD close loop
│   ├── pty_windows.zig     # Windows-specific: ConPTY (CreatePseudoConsole + pipes)
│   ├── errno_shim.c        # Android errno compat (__errno_location → __errno)
│   └── win/
│       ├── napi.zig        # NAPI↔lib.zig bridge for Windows (spawn, write, resize, kill, close)
│       └── node_api.def    # NAPI import definitions (→ .lib via zig dlltool)
├── src/                    # TypeScript wrapper + tests
│   ├── index.ts            # Public API: spawn(), open() — platform dispatch
│   ├── napi.ts             # Native module loader (platform-aware, INativeUnix/INativeWindows)
│   ├── terminal.ts         # Terminal class (Bun-compatible) + TerminalOptions type
│   ├── pty/                # PTY class hierarchy
│   │   ├── _base.ts        # BasePty abstract class — shared state, events, waitFor, buildEnvPairs
│   │   ├── types.ts        # IPty, IPtyOptions, IDisposable, IEvent interfaces
│   │   ├── unix.ts         # UnixPty: tty.ReadStream + async fs.write
│   │   ├── windows.ts      # WindowsPty: native callbacks + deferred init
│   │   └── pipe.ts         # PipePty: pure-TS fallback when native bindings unavailable
│   ├── spawn.test.ts       # E2E tests (platform-conditional)
│   ├── pipe.test.ts        # PipePty fallback tests
│   └── terminal.test.ts    # Terminal class tests
├── dist/                   # Built output (obuild → .mjs + .d.mts)
├── prebuilds/              # Zig build output (8 binaries, see below)
├── scripts/
│   └── cross-platform.sh   # Docker-based cross-platform smoke tests
└── .github/workflows/
    └── ci.yml              # PR/push: build + test (Linux, macOS, Windows)
```

### TypeScript Class Hierarchy

```
IPty (interface, src/pty/types.ts)
  └── BasePty (abstract, src/pty/_base.ts)
        ├── UnixPty (src/pty/unix.ts)       — native PTY via Zig NAPI
        ├── WindowsPty (src/pty/windows.ts) — native ConPTY via Zig NAPI
        └── PipePty (src/pty/pipe.ts)       — pure-TS fallback (child_process pipes)

Terminal (standalone, src/terminal.ts) — Bun-compatible callbacks, AsyncDisposable
```

**BasePty** contains shared logic:

- State: `_dataListeners`, `_exitListeners`, `_closed`, `_exitCode`, `_exited` promise, `_terminal`
- Event getters: `onData`, `onExit`, `exited`, `exitCode`
- `waitFor(pattern, { timeout? })` — waits for string in output, hooks into both `onData` and Terminal data paths
- `_handleExit(info)` — common exit callback (set closed, fire listeners, resolve promise)
- `buildEnvPairs(env, termName?, sanitizeKeys?)` — shared env builder

**UnixPty** adds: fd management, `tty.ReadStream`, async write queue with EAGAIN retry, flow control, `process` via native, signal-based `kill()`.

**WindowsPty** adds: ConPTY handle, deferred calls until ready, `napi_threadsafe_function` data/exit callbacks.

**PipePty** (fallback, no native dependency): Spawns child via `child_process.spawn` with `stdio: ["pipe", "pipe", "pipe"]`. Emulates terminal behavior in userspace:

- Signal character translation (`^C`→SIGINT, `^Z`→SIGTSTP, `^\`→SIGQUIT, `^D`→EOF)
- Canonical mode with echo (line buffering, backspace, `^W` word erase, `^U` line kill, `^R` reprint)
- Raw mode (`setRawMode()` / `setCanonicalMode()`) — disables echo and line buffering
- XON/XOFF flow control interception when `handleFlowControl` is enabled
- Force-color env hints (`FORCE_COLOR=1`, `COLORTERM=truecolor`) auto-set
- `SIGWINCH` sent on `resize()` as best-effort hint
- Foreground process tracking via `/proc/<pid>/stat` → `/proc/<pgrp>/cmdline` (Linux only)
- Merges stdout + stderr into single data stream (matching real PTY behavior)

**Native loading** (`napi.ts`): `loadNative()` returns `null` on failure instead of throwing. `hasNative` boolean exported for runtime detection. `spawn()` in `index.ts` routes to `PipePty` when `hasNative === false`.

### Zig Source Layers

The Zig code is split into two layers:

1. **Pure Zig library** (`lib.zig` + `pty_linux.zig` + `pty_darwin.zig` + `pty_windows.zig` + `termios.zig`) — No NAPI dependency. `lib.zig` dispatches to platform-specific modules via `builtin.os.tag`. Unix exposes `forkPty`, `openPty`, `resize`, `getProcessName`, `waitForExit`. Windows exposes `spawnConPty`, `readOutput`, `writeInput`, `resizeConsole`, `waitForExit`, `killProcess`, `closePty`. Can be imported by any Zig project via `@import("zigpty")`.

2. **NAPI wrapper** (`root.zig` + `pty.zig` + `pty_unix.zig` + `win/napi.zig` + `napi.zig`) — Thin bridge that parses NAPI arguments and calls `lib.zig`. `pty.zig` contains shared helpers and re-exports platform-specific symbols. `pty_unix.zig` handles Unix (fork, open, resize, process). `win/napi.zig` handles Windows ConPTY (spawn, write, resize, kill, close). Registers different exports on Windows vs Unix. Manages `napi_threadsafe_function` for exit monitoring and (on Windows) data streaming.

## Build

```sh
# Debug build (native + cross targets — all 8 platforms)
zig build

# Release build (native + cross targets)
zig build --release

# Build single target only
zig build -Dtarget=aarch64-linux-musl
zig build -Dtarget=x86_64-windows

# Build TS (via obuild, also runs zig build --release)
bun run build

# Run tests
bun test

# Cross-platform smoke tests (Docker, Linux only)
bash scripts/cross-platform.sh
```

### Prebuilds

`zig build` produces 8 binaries by default (native + `cross_targets` in `build.zig`):

| File                           | Target                               |
| ------------------------------ | ------------------------------------ |
| `zigpty.linux-x64.node`        | x64 glibc (Debian/Ubuntu/Fedora)     |
| `zigpty.linux-x64-musl.node`   | x64 musl (Alpine)                    |
| `zigpty.linux-arm64.node`      | arm64 glibc (Ubuntu on Graviton/RPi) |
| `zigpty.linux-arm64-musl.node` | arm64 musl (Alpine arm64 + Android)  |
| `zigpty.darwin-arm64.node`     | macOS arm64 (Apple Silicon)          |
| `zigpty.darwin-x64.node`       | macOS x64 (Intel)                    |
| `zigpty.win32-x64.node`        | Windows x64                          |
| `zigpty.win32-arm64.node`      | Windows arm64                        |

The native loader (`napi.ts`) tries glibc first, falls back to musl on Linux. On Android (`platform() === "android"`), maps to `linux` and loads the musl binary. Musl builds include a weak errno shim for Android/Bionic compatibility. Musl builds use direct `linux.syscall3(.close_range, ...)` to avoid libc symbol dependencies. Windows builds don't link libc.

## Zig Package API

### Unix (Linux + macOS)

The pure Zig library (`lib.zig`) is exposed as the `"zigpty"` module in `build.zig`:

| Function         | Signature                                  | Description                                                 |
| ---------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `forkPty`        | `(ForkOptions) !ForkResult`                | Fork process with PTY (forkpty + signal handling + execvpe) |
| `openPty`        | `(cols, rows) !OpenResult`                 | Open bare PTY pair                                          |
| `resize`         | `(fd, cols, rows, x_pixel, y_pixel) !void` | Resize PTY (ioctl TIOCSWINSZ)                               |
| `getProcessName` | `(fd, buf) ?[]const u8`                    | Foreground process name via /proc                           |
| `getStats`       | `(fd, cwd_buf) ?Stats`                     | cwd + rss + cpu for foreground pgrp (Linux: /proc; macOS: proc_pidinfo) |
| `waitForExit`    | `(pid) ExitInfo`                           | Blocking wait for child exit (call from background thread)  |

Types: `ForkOptions`, `ForkResult`, `OpenResult`, `ExitInfo`, `Stats`, `PtyError`, `Fd`, `Pid`

### Windows

Available via `lib.win` (re-exports `pty_windows.zig`):

| Function        | Signature                                             | Description                              |
| --------------- | ----------------------------------------------------- | ---------------------------------------- |
| `createConPty`  | `(cols, rows) !ConPtySetup`                           | Phase 1: create pipes + pseudo console   |
| `startProcess`  | `(hpc, cmd_line, env_block, cwd) !{process, pid}`     | Phase 2: spawn process in ConPTY         |
| `spawnConPty`   | `(cmd_line, env_block, cwd, cols, rows) !SpawnResult` | Convenience: createConPty + startProcess |
| `readOutput`    | `(conout, buf) usize`                                 | Read from output pipe (blocking)         |
| `writeInput`    | `(conin, data) !void`                                 | Write to input pipe                      |
| `resizeConsole` | `(hpc, cols, rows) !void`                             | Resize pseudo console                    |
| `waitForExit`   | `(process) ExitInfo`                                  | Wait for process exit (blocking)         |
| `killProcess`   | `(process, exit_code) void`                           | Terminate process                        |
| `closePty`      | `(result) void`                                       | Close all ConPTY handles                 |
| `getStats`      | `(process, cwd_buf) ?Stats`                           | rss + cpu via K32GetProcessMemoryInfo + GetProcessTimes (no cwd) |

Types: `SpawnResult`, `ConPtySetup`, `ExitInfo`, `Stats`, `ConPtyError`, `HPCON`, `HANDLE`

## NAPI API (Zig → JS)

### Unix Exports

| Export    | Signature                                                                       | Implementation                           |
| --------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| `fork`    | `(file, args[], env[], cwd, cols, rows, uid, gid, utf8, cb)` → `{fd, pid, pty}` | `lib.forkPty()` + thread `waitForExit()` |
| `open`    | `(cols, rows)` → `{master, slave, pty}`                                         | `lib.openPty()`                          |
| `resize`  | `(fd, cols, rows)` → void                                                       | `lib.resize()`                           |
| `process` | `(fd)` → string                                                                 | `lib.getProcessName()`                   |
| `stats`   | `(fd)` → `{pid, cwd, rssBytes, cpuUser, cpuSys}` \| undefined                   | `lib.getStats()` (foreground pgrp)       |

### Windows Exports

| Export   | Signature                                                                  | Implementation                                  |
| -------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| `spawn`  | `(file, args[], env[], cwd, cols, rows, onData, onExit)` → `{pid, handle}` | `win.spawnConPty()` + read thread + exit thread |
| `write`  | `(handle, data)` → void                                                    | `win.writeInput()`                              |
| `resize` | `(handle, cols, rows)` → void                                              | `win.resizeConsole()`                           |
| `kill`   | `(handle)` → void                                                          | `win.killProcess()`                             |
| `close`  | `(handle)` → void                                                          | `win.closePty()`                                |
| `stats`  | `(handle)` → `{pid, cwd, rssBytes, cpuUser, cpuSys}` \| undefined          | `win.getStats()` (shell process, cwd always null) |

Windows uses `napi_external` to wrap the `WinConPtyContext` handle. Data flows from a Zig read thread to JS via `napi_threadsafe_function` (onData callback).

## JS API

```ts
import { spawn } from "zigpty";

// Works on all platforms — spawn() dispatches to UnixPty or WindowsPty
const pty = spawn("/bin/bash", [], { cols: 120, rows: 40 });
// Windows: spawn("cmd.exe", [], { cols: 120, rows: 40 })

pty.onData((data) => process.stdout.write(data));
pty.onExit(({ exitCode }) => console.log("exited:", exitCode));
pty.write("echo hello\n");
pty.resize(80, 24);
pty.kill("SIGTERM"); // Windows: kill() terminates the process
```

### `waitFor(pattern, options?)`

Wait for a specific string to appear in the PTY output. Useful for AI agents driving interactive programs.

```ts
const pty = spawn("python3", ["-c", `name = input("name? ")`]);
await pty.waitFor("name?"); // resolves when output contains "name?"
pty.write("zigpty\n");
```

Options: `{ timeout?: number }` (default: 30s). Throws on timeout.

### `stats()`

On-demand snapshot of OS-level process info for the PTY. Returns `{pid, cwd, rssBytes, cpuUser, cpuSys}` or `null`. CPU times are in microseconds, `rssBytes` is resident set size.

- **Unix**: targets the PTY's foreground process group (same target as `pty.process`), so the numbers follow whatever the user is currently running. Linux reads `/proc/<pid>/{cwd,stat}`; macOS uses `proc_pidinfo(PROC_PIDTASKINFO)` + `proc_pidinfo(PROC_PIDVNODEPATHINFO)`.
- **Windows**: reports the spawned shell process (no ConPTY foreground tracking). `rssBytes` via `K32GetProcessMemoryInfo`, CPU via `GetProcessTimes`. `cwd` is always `null` — reading another process's cwd requires `NtQueryInformationProcess` + remote PEB read, which is fragile across elevation boundaries.
- **PipePty** (fallback): implemented in TypeScript on Linux only (reads `/proc/<child_pid>/{cwd,stat}`). Returns `null` on other platforms.

No background thread — stats are pulled only when called. Returns `null` after close or when the process has exited.

### Terminal API (Bun-compatible)

`spawn()` accepts optional `terminal: TerminalOptions | Terminal` in options for callback-based data (`Uint8Array`) and `Promise`-based exit (`pty.exited`). `IPty` now has `exited: Promise<number>` and `exitCode: number | null`. `Terminal` class (`terminal.ts`) can be standalone (`new Terminal()` opens bare PTY) or passed to `spawn()` (attaches to fork's fd on Unix, ConPTY handle on Windows). Supports `AsyncDisposable`.

## Key Design Decisions

- **Graceful fallback**: `loadNative()` returns `null` instead of throwing when native bindings can't load. `spawn()` auto-routes to `PipePty` (pure TypeScript, `child_process.spawn` with pipes). This prevents hard crashes in containers, sandboxes, CI without prebuilds, or WASM runtimes. `open()` throws a clear error in fallback mode since bare PTY pairs require kernel support.
- **Userspace line discipline in PipePty**: Canonical mode buffers input line-by-line with echo, backspace, `^W`/`^U`/`^R` handling. Raw mode (`setRawMode()`) passes bytes through directly. Signal chars (`^C`/`^Z`/`^\`/`^D`) are intercepted in the write path and translated to OS signals / EOF regardless of mode.
- **Two-layer architecture**: Pure Zig library (`lib.zig`) with thin NAPI wrapper. Enables Zig package use without Node.js dependency.
- **BasePty abstract class**: Shared state management, event listeners, `waitFor`, and exit handling extracted into `_base.ts`. `UnixPty` and `WindowsPty` extend it with platform-specific logic only.
- **Raw NAPI over tokota/zig-napi**: Zero dependency risk. `napi.zig` is ~240 lines of pure `extern` declarations.
- **Pure extern declarations**: `forkpty`, `openpty`, `waitpid`, etc. declared as `extern fn` — no `@cImport` for platform-specific headers. NAPI and Windows kernel32 are also pure Zig externs.
- **Platform dispatch via `builtin.os.tag`**: `lib.zig` imports `pty_linux.zig`, `pty_darwin.zig`, or `pty_windows.zig` at comptime. Unix and Windows APIs are conditionally compiled.
- **Signal blocking around fork** (Unix): Prevents race conditions (matches node-pty behavior).
- **`close_range` syscall with `/proc/self/fd` fallback** (Linux): Direct syscall (not libc extern) to close leaked FDs — avoids musl symbol issues.
- **FD close loop** (macOS): No `/proc/self/fd` or `close_range` — closes FDs 3..255.
- **Process name via sysctl** (macOS): `sysctl(KERN_PROC_PID)` → `kinfo_proc.kp_proc.p_comm` (offset 243).
- **`execvp` + environ** (macOS): No `execvpe` — sets `environ` global then calls `execvp`.
- **ConPTY with anonymous pipes** (Windows): `CreatePseudoConsole` + `CreateProcessW` with `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`. I/O via anonymous pipes (simpler than named pipes).
- **`STARTF_USESTDHANDLES` with null handles** (Windows): Critical for ConPTY — without this flag, the spawned process inherits the parent's real console handles and output bypasses the ConPTY pipe entirely. Setting the flag with null `hStdInput`/`hStdOutput`/`hStdError` forces the process to use the pseudo console for all I/O.
- **Two-phase ConPTY startup** (Windows): `createConPty` creates pipes + pseudo console, then read thread starts draining the output pipe, then `startProcess` spawns the process. This ensures no output is lost for fast-exiting processes (matches node-pty's two-phase approach).
- **Zig read thread for Windows**: Reads ConPTY output pipe in a background thread, forwards data to JS via `napi_threadsafe_function`. Avoids pipe-fd ↔ Node.js compatibility issues.
- **Deferred calls on Windows**: `WindowsPty` buffers write/resize calls until first data is received (prevents ConPTY deadlock on startup).
- **No libc on Windows**: Windows builds don't link libc — uses `page_allocator` instead of `c_allocator`.
- **NAPI import lib via dlltool** (Windows): `win/node_api.def` lists NAPI symbols imported from `node.exe`. Build generates import `.lib` at build time via `zig dlltool` — no checked-in binaries.
- **ConPTY flush on exit** (Windows): `ClosePseudoConsole` must be called after process exit to flush remaining output. Input pipe is closed first, then pseudo console, while read thread drains output concurrently to avoid deadlock.
- **`tty.ReadStream`** for reading PTY output on Unix (not `net.Socket` — PTY fds are TTY type).
- **Async `fs.write`** with EAGAIN retry for writing on Unix (non-blocking write queue with `setImmediate` backoff).
- **Android errno shim** (`zig/errno_shim.c`): Android's Bionic libc uses `__errno()` instead of musl's `__errno_location()`. All musl builds link a tiny C shim with weak symbols — `__errno_location` (weak defined) forwards to `__errno` (weak undefined). On musl Linux, musl's strong `__errno_location` overrides the shim. On Android/Bionic, the shim activates and `__errno` resolves from Bionic's libc. No separate Android binary needed.
- **Platform-aware native loading**: `napi.ts` resolves `zigpty.<os>-<arch>.node` with glibc→musl fallback on Linux. On Android (`platform() === "android"`), maps to `linux` and loads the musl binary.
- **`ptsname_r`/`ttyname_r`** in lib.zig (thread-safe) vs `ptsname`/`ttyname` in old pty.zig.
- **Raw `execve` syscall + PATH search** (Linux): `execChild` uses raw `linux.execve` instead of musl's `execvpe`. On `EACCES` (noexec mount), falls back to `execveLinkerFallback` which reads the ELF `PT_INTERP` header and re-execs via the dynamic linker (e.g. `/system/bin/linker64`). This is the same technique Termux's `libtermux-exec.so` uses. Zero overhead on normal Linux — the fallback is only triggered on `EACCES`.
- **`rawExit` via `exit_group` syscall** (Linux) / `_exit` (macOS): After `fork()`, the child must not call musl's `exit()` which runs atexit handlers registered by Node.js/V8 — on Android these expect Bionic's libc state, causing hangs or zombies. `exit_group` syscall (Linux) or `_exit` (macOS) terminates immediately without atexit handlers.

## Android/Termux Pitfalls

### `execve` fails with `EACCES` on Termux binaries

**Root cause:** `/data/data` is mounted as tmpfs with `noexec`. Termux binaries live under `/data/data/com.termux/files/usr/bin/` — the kernel enforces the parent mount's `noexec` flag on `execve()`. Termux normally works around this via `LD_PRELOAD=libtermux-exec.so`, which intercepts `execve` and rewrites it to invoke the ELF dynamic linker (`/system/bin/linker64`) directly. VS Code's ptyHost process is forked without `LD_PRELOAD`, so `libtermux-exec.so` is absent and native `execve` fails.

**Fix:** `execveLinkerFallback` reads the ELF `PT_INTERP` header from the target binary to get the dynamic linker path, then calls `execve(linker_path, [argv0, binary_path, ...rest], envp)`. Only triggered on `EACCES`, so normal Linux is unaffected.

### musl's `exit()` hangs after `fork()` on Android

**Root cause:** After `fork()`, calling musl's `exit()` (via `std.process.exit`) runs atexit handlers registered by Node.js/V8, which expect Bionic's libc state — this can hang or crash, leaving zombie processes.

**Fix:** `rawExit` calls the `exit_group` syscall directly on Linux (or `_exit` on macOS), bypassing all atexit handlers.

### Android can't be distinguished at comptime

Zig cross-compiles for `aarch64-linux-musl` — same target for both Android and regular Linux ARM64. The `EACCES` check is the runtime gate: it only fires on noexec mounts (Android), so no comptime or explicit Android detection is needed.

## Windows ConPTY Pitfalls

Critical lessons learned from debugging the Windows ConPTY implementation. These are subtle issues not well-documented by Microsoft that can cause silent data loss or broken I/O.

### `STARTF_USESTDHANDLES` is mandatory

**Symptom:** ConPTY appears to work — init VT sequences (mode changes, clear screen, title) arrive through the output pipe — but ALL actual process output (echo, command output, etc.) goes to the real console instead.

**Root cause:** Without `STARTF_USESTDHANDLES` in `STARTUPINFO.dwFlags`, `CreateProcessW` inherits the parent's real console handles. The pseudo console is attached via `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, but the std handles still point to the real console. Process output writes to the real console directly, bypassing the ConPTY pipe.

**Fix:** Set `si.StartupInfo.dwFlags = STARTF_USESTDHANDLES` with null `hStdInput`/`hStdOutput`/`hStdError`. This forces the process to create its console handles through the pseudo console. node-pty does the same — see `conpty.cc` → `PtyConnect`.

**Debugging note:** This is extremely hard to diagnose because ConPTY's own VT init sequences DO arrive through the pipe (they're generated by ConPTY itself, not by the process). The process output silently goes elsewhere. On CI runners without a visible console, the output just vanishes. Adding `console.log` in the data callback shows init chunks arriving, making it look like the pipe works — but only ConPTY-generated data flows through it.

### `ClosePseudoConsole` deadlocks if called from the JS thread

**Symptom:** `close()` hangs indefinitely on Windows.

**Root cause:** `ClosePseudoConsole` blocks until the output pipe is fully drained. If the read thread delivers data via `napi_threadsafe_function`, the tsfn callback must fire on the JS thread. If the JS thread is blocked by `ClosePseudoConsole`, the callback can never run → deadlock.

**Fix:** Only call `ClosePseudoConsole` from the exit monitor thread (background), never from JS-thread functions like `winCloseImpl`. The JS-side `close()` should just `killProcess` — the exit monitor handles the rest.

### ConPTY exit cleanup order matters

**Correct order** after `waitForExit` returns:

1. Close input pipe (`closeConin`) — no more input after process exit
2. Call `ClosePseudoConsole` — flushes remaining VT output, closes output pipe write end
3. Join read thread — it gets EOF from step 2 and exits
4. Close remaining handles (`closePty`)
5. Fire exit callback — all data has been delivered

**Why this order:** `ClosePseudoConsole` blocks until the output pipe is drained. The read thread must be running concurrently to drain it (step 3 after step 2). Closing conin first (step 1) prevents the ConPTY from reading stale input during shutdown.

### `CreatePseudoConsole` duplicates pipe handles

The inner pipe handles (`pipe_in_read`, `pipe_out_write`) passed to `CreatePseudoConsole` ARE duplicated internally. It is safe to close them after `CreatePseudoConsole` returns. However, for clarity and to match node-pty's pattern, we close them after `startProcess`/`CreateProcessW`.

### Differences from node-pty's architecture

| Aspect          | node-pty                                                                                  | zigpty                                                                 |
| --------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Pipe type       | Named pipes (128KB buffers)                                                               | Anonymous pipes (default ~4KB)                                         |
| Output reading  | Worker thread → IPC → Socket → JS                                                         | Zig read thread → `napi_threadsafe_function` → JS                      |
| Process spawn   | Two-phase: `startProcess` (create ConPTY) → `connect` (ConnectNamedPipe + CreateProcessW) | Two-phase: `createConPty` → `startProcess` (CreateProcessW)            |
| Exit handling   | Never calls `ClosePseudoConsole` on normal exit; 1000ms flush timer then socket close     | Calls `ClosePseudoConsole` from exit monitor thread after process exit |
| Kill handling   | `ClosePseudoConsole` + `TerminateProcess` (via `PtyKill`)                                 | `TerminateProcess` from JS; `ClosePseudoConsole` from exit monitor     |
| Native bindings | C++ with node-addon-api                                                                   | Pure Zig raw NAPI externs (~240 lines)                                 |
