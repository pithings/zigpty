import type { Terminal, TerminalOptions } from "../terminal.ts";

export interface IEvent<T> {
  (listener: (data: T) => void): IDisposable;
}

export interface IDisposable {
  dispose(): void;
}

export interface IPty {
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
}
