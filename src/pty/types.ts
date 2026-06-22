import type { Terminal, TerminalOptions } from "../terminal.ts";

export interface IEvent<T> {
  (listener: (data: T) => void): IDisposable;
}

export interface IDisposable {
  dispose(): void;
}

/**
 * A sink that consumes PTY output. Pass to {@link IPty.attach} to wire it
 * onto a PTY's data stream.
 *
 * Anything with a `feed(data)` method conforms — including `OSCInspector`,
 * a terminal recorder, a logger, etc. Optional lifecycle hooks let the
 * consumer react to attach/detach (which also fires when the PTY exits).
 */
export interface IPtyConsumer {
  /** Receive a chunk of PTY output. */
  feed(data: string | Buffer): void;
  /** Optional: called once when attached, before the first `feed`. */
  onAttach?(pty: IPty): void;
  /** Optional: called once when detached (explicit dispose or PTY exit). */
  onDetach?(pty: IPty): void;
  /** Optional: called after the PTY is resized, with the new dimensions. */
  onResize?(cols: number, rows: number): void;
}

export interface IPtyChildStats {
  /** Process ID. */
  pid: number;
  /** Short executable / command name (truncated to ~15 chars on Unix, up to 31 on Windows). */
  name: string;
  /** Resident set size (physical memory) in bytes. */
  rssBytes: number;
  /** Accumulated user-mode CPU time in microseconds. */
  cpuUser: number;
  /** Accumulated system-mode CPU time in microseconds. */
  cpuSys: number;
}

export interface IPtyStats {
  /** Leader PID — the spawned process (e.g. the shell). */
  pid: number;
  /** Leader's current working directory. `null` when unavailable (always on Windows, or when the process has exited). */
  cwd: string | null;
  /** Total resident set size (physical memory) in bytes, aggregated across leader + descendants. */
  rssBytes: number;
  /** Total accumulated user-mode CPU time in microseconds, aggregated across leader + descendants. */
  cpuUser: number;
  /** Total accumulated system-mode CPU time in microseconds, aggregated across leader + descendants. */
  cpuSys: number;
  /** Total number of processes aggregated (leader + descendants). Always `>= 1`. */
  count: number;
  /**
   * Non-leader transitive descendants (BFS by ppid) aggregated into the totals.
   * Catches background jobs, subshells, pipelines, and grandchildren of the leader.
   * Double-fork daemons that reparent to init/launchd are not tracked.
   */
  children: IPtyChildStats[];
}

export interface IPty extends AsyncDisposable {
  /** Process ID of the spawned process. */
  pid: number;
  /** Number of columns. */
  cols: number;
  /** Number of rows. */
  rows: number;
  /** Name of the current foreground process. */
  readonly process: string;
  /** Whether to intercept flow control characters. */
  handleFlowControl: boolean;
  /** Promise that resolves with the exit code when the process exits. */
  readonly exited: Promise<number>;
  /** The exit code, or null if still running. */
  readonly exitCode: number | null;
  /** Fires when data is received from the PTY. */
  onData: IEvent<string | Buffer>;
  /** Fires when the process exits. */
  onExit: IEvent<{ exitCode: number; signal: number }>;
  /** Write data to the PTY. */
  write(data: string): void;
  /** Resize the PTY. */
  resize(cols: number, rows: number, pixelSize?: { width: number; height: number }): void;
  /** Clear the PTY buffer (no-op on Unix). */
  clear(): void;
  /** Kill the process. */
  kill(signal?: string): void;
  /** Pause reading from the PTY. */
  pause(): void;
  /** Resume reading from the PTY. */
  resume(): void;
  /** Close the PTY, closing file descriptors and cleaning up resources. */
  close(): void;
  /** Wait until the output contains the given string. Resolves with all output collected so far. */
  waitFor(pattern: string, options?: { timeout?: number }): Promise<string>;
  /** Snapshot OS-level stats (cwd, memory, CPU time) aggregated across the leader process and every transitive descendant. Returns null when unavailable. */
  stats(): IPtyStats | null;
  /**
   * Attach a consumer to the PTY's output stream. The consumer's `feed`
   * receives every data chunk. Returns an `IDisposable` to detach early;
   * the consumer is also auto-detached when the PTY exits.
   */
  attach(consumer: IPtyConsumer): IDisposable;
}

export interface IPtyOpenOptions {
  cols?: number;
  rows?: number;
  encoding?: BufferEncoding | null;
}

export interface IOpenResult {
  master: number;
  slave: number;
  pty: string;
}

export interface IPtyOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  encoding?: BufferEncoding | null;
  uid?: number;
  gid?: number;
  handleFlowControl?: boolean;
  flowControlPause?: string;
  flowControlResume?: string;
  /** Terminal options or an existing Terminal instance. When provided, data flows through terminal callbacks. */
  terminal?: TerminalOptions | Terminal;
  /** Called when the process exits (alternative to onExit event). */
  onExit?: (exitCode: number, signal: number) => void;
  /** Force pipe-based PTY fallback even when native bindings are available. */
  pipe?: boolean;
  /** Treat the command as an interactive shell (auto-enables `-i`, raw mode, stderr merge). Auto-detected for known shells (bash, zsh, sh, fish, etc.) when unset. */
  shell?: boolean;
}
