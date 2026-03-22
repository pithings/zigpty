import * as fs from "node:fs";
import * as os from "node:os";
import * as tty from "node:tty";
import { native } from "./napi.ts";
import type { IDisposable, IEvent, IPty, IPtyOptions } from "./types.ts";
import { Terminal } from "./terminal.ts";
import type { TerminalOptions } from "./terminal.ts";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

// Default flow control characters
const DEFAULT_FLOW_PAUSE = "\x13"; // XOFF
const DEFAULT_FLOW_RESUME = "\x11"; // XON

export class UnixTerminal implements IPty {
  pid: number;
  cols: number;
  rows: number;
  handleFlowControl: boolean;

  private _fd: number;
  private _pty: string;
  private _readable: tty.ReadStream;
  private _encoding: BufferEncoding | null;
  private _flowControlPause: string;
  private _flowControlResume: string;
  private _dataListeners: Array<(data: string | Buffer) => void> = [];
  private _exitListeners: Array<(info: { exitCode: number; signal: number }) => void> = [];
  private _closed = false;
  private _writeQueue: Array<{ buffer: Buffer; offset: number }> = [];
  private _writing = false;
  private _writeImmediate: ReturnType<typeof setImmediate> | null = null;
  private _exitCode: number | null = null;
  private _resolveExited!: (code: number) => void;
  private _exited: Promise<number>;
  private _terminal?: Terminal;

  constructor(file: string, args: string[], options?: IPtyOptions) {
    const cols = options?.cols ?? DEFAULT_COLS;
    const rows = options?.rows ?? DEFAULT_ROWS;
    const cwd = options?.cwd ?? process.cwd();
    const encoding = options?.encoding !== undefined ? options.encoding : "utf8";
    const uid = options?.uid ?? -1;
    const gid = options?.gid ?? -1;
    const useUtf8 = encoding === "utf8" || encoding === null;

    this._exited = new Promise<number>((resolve) => {
      this._resolveExited = resolve;
    });

    // Set up terminal if provided
    if (options?.terminal) {
      this._terminal =
        options.terminal instanceof Terminal
          ? options.terminal
          : new Terminal(options.terminal as TerminalOptions);
    }

    // Build env array: "KEY=VALUE" pairs
    const envObj = options?.env ?? process.env;
    const envPairs = buildEnvPairs(envObj, options?.name);

    const result = native.fork(file, args, envPairs, cwd, cols, rows, uid, gid, useUtf8, (info) => {
      this._closed = true;
      this._exitCode = info.exitCode;
      options?.onExit?.(info.exitCode, info.signal);
      for (const listener of this._exitListeners) {
        listener(info);
      }
      this._resolveExited(info.exitCode);
      try {
        this._readable.destroy();
      } catch {}
    });

    this.pid = result.pid;
    this.cols = cols;
    this.rows = rows;
    this.handleFlowControl = options?.handleFlowControl ?? false;
    this._fd = result.fd;
    this._pty = result.pty;
    this._encoding = encoding;
    this._flowControlPause = options?.flowControlPause ?? DEFAULT_FLOW_PAUSE;
    this._flowControlResume = options?.flowControlResume ?? DEFAULT_FLOW_RESUME;

    // Attach terminal to fork's fd if provided
    if (this._terminal) {
      this._terminal._attachUnixFd(this._fd);
    }

    // Create readable stream from master fd
    this._readable = new tty.ReadStream(this._fd);
    if (encoding) {
      this._readable.setEncoding(encoding);
    }
    this._readable.on("data", (data: string | Buffer) => {
      // Flow control interception (only for string data)
      if (this.handleFlowControl && typeof data === "string") {
        if (data === this._flowControlPause || data === this._flowControlResume) return;
      }

      for (const listener of this._dataListeners) {
        listener(data);
      }
    });
    this._readable.on("error", () => {});
  }

  get exited(): Promise<number> {
    return this._exited;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get process(): string {
    try {
      return native.process(this._fd) ?? "";
    } catch {
      return "";
    }
  }

  get onData(): IEvent<string | Buffer> {
    return (listener): IDisposable => {
      this._dataListeners.push(listener);
      return {
        dispose: () => {
          const idx = this._dataListeners.indexOf(listener);
          if (idx >= 0) this._dataListeners.splice(idx, 1);
        },
      };
    };
  }

  get onExit(): IEvent<{ exitCode: number; signal: number }> {
    return (listener): IDisposable => {
      this._exitListeners.push(listener);
      return {
        dispose: () => {
          const idx = this._exitListeners.indexOf(listener);
          if (idx >= 0) this._exitListeners.splice(idx, 1);
        },
      };
    };
  }

  write(data: string): void {
    if (this._closed) return;
    const buf = Buffer.from(data, this._encoding || "utf8");
    this._writeQueue.push({ buffer: buf, offset: 0 });
    this._processWriteQueue();
  }

  resize(cols: number, rows: number, pixelSize?: { width: number; height: number }): void {
    if (this._closed) return;
    this.cols = cols;
    this.rows = rows;
    native.resize(this._fd, cols, rows, pixelSize?.width ?? 0, pixelSize?.height ?? 0);
  }

  clear(): void {
    // No-op on Unix (ConPTY-only feature)
  }

  kill(signal?: string): void {
    if (this._closed) return;
    const sig = signalNumber(signal ?? "SIGHUP");
    try {
      process.kill(this.pid, sig);
    } catch {}
  }

  pause(): void {
    this._readable.pause();
  }

  resume(): void {
    this._readable.resume();
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;

    // Cancel pending writes
    if (this._writeImmediate) {
      clearImmediate(this._writeImmediate);
      this._writeImmediate = null;
    }
    this._writeQueue.length = 0;

    // Destroy the readable stream
    try {
      this._readable.destroy();
    } catch {}

    // Close the master fd
    try {
      fs.closeSync(this._fd);
    } catch {}

    // Kill the process if still alive
    try {
      process.kill(this.pid, 0);
      process.kill(this.pid, "SIGHUP");
    } catch {}
  }

  private _processWriteQueue(): void {
    if (this._writing || this._writeQueue.length === 0 || this._closed) return;
    this._writing = true;

    const task = this._writeQueue[0]!;
    fs.write(this._fd, task.buffer, task.offset, (err, written) => {
      this._writing = false;

      if (err) {
        if ("code" in err && err.code === "EAGAIN") {
          // Retry on next tick — PTY buffer is full
          this._writeImmediate = setImmediate(() => this._processWriteQueue());
          return;
        }
        // Discard queue on unrecoverable error
        this._writeQueue.length = 0;
        return;
      }

      task.offset += written;
      if (task.offset >= task.buffer.length) {
        this._writeQueue.shift();
      }
      this._processWriteQueue();
    });
  }
}

function buildEnvPairs(env: Record<string, string | undefined>, termName?: string): string[] {
  const pairs: string[] = [];
  const envCopy = { ...env };

  // Set TERM if specified and not already in env
  if (termName && !envCopy.TERM) {
    envCopy.TERM = termName;
  }

  // Sanitize: remove vars that could confuse the child process
  for (const key of [
    "TMUX",
    "TMUX_PANE",
    "STY",
    "WINDOW",
    "WINDOWID",
    "TERMCAP",
    "COLUMNS",
    "LINES",
  ]) {
    delete envCopy[key];
  }

  for (const [key, value] of Object.entries(envCopy)) {
    if (value !== undefined) {
      pairs.push(`${key}=${value}`);
    }
  }
  return pairs;
}

function signalNumber(signal: string): number {
  const signals: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGTERM: 15,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGUSR2: 12,
  };
  return signals[signal] ?? (os.constants.signals as Record<string, number>)[signal] ?? 1;
}
