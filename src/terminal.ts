import * as fs from "node:fs";
import * as tty from "node:tty";
import { isWindows, native, type INativeUnix, type INativeWindows } from "./napi.ts";
import { WriteQueue } from "./pty/_writeQueue.ts";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export interface TerminalOptions {
  /** Number of columns. Default: 80 */
  cols?: number;
  /** Number of rows. Default: 24 */
  rows?: number;
  /** Terminal type name (sets TERM env var). Default: "xterm-256color" */
  name?: string;
  /** Callback when data is received from the terminal. */
  data?: (terminal: Terminal, data: Uint8Array) => void;
  /** Callback when PTY stream closes (EOF or error). exitCode is PTY lifecycle status (0=EOF, 1=error). */
  exit?: (terminal: Terminal, exitCode: number, signal: string | null) => void;
  /** Callback when the terminal is ready for more data. */
  drain?: (terminal: Terminal) => void;
}

/**
 * Standalone terminal (PTY).
 *
 * Can be created standalone via `new Terminal()` or passed to `spawn()` via the
 * `terminal` option for callback-based data handling.
 *
 * Supports `AsyncDisposable` (`await using`).
 */
export class Terminal implements AsyncDisposable {
  stdin: number;
  stdout: number;

  private _closed = false;
  private _cols: number;
  private _rows: number;
  private _name: string;
  private _onData?: (terminal: Terminal, data: Uint8Array) => void;
  private _onExit?: (terminal: Terminal, exitCode: number, signal: string | null) => void;
  private _onDrain?: (terminal: Terminal) => void;
  /** @internal Listeners for waitFor support. */
  _dataListeners: Array<(data: string) => void> = [];

  // Unix internals
  private _readable?: tty.ReadStream;
  private _wq?: WriteQueue;

  // Windows internals
  private _winHandle?: object;
  private _winNative?: INativeWindows;
  private _winReady = false;
  private _winDeferred: Array<() => void> = [];

  // Whether this Terminal owns its PTY (standalone) vs attached to a spawn
  private _standalone: boolean;

  constructor(options?: TerminalOptions) {
    this._cols = options?.cols ?? DEFAULT_COLS;
    this._rows = options?.rows ?? DEFAULT_ROWS;
    this._name = options?.name ?? "xterm-256color";
    this._onData = options?.data;
    this._onExit = options?.exit;
    this._onDrain = options?.drain;
    this._standalone = true;
    this.stdin = -1;
    this.stdout = -1;

    // Standalone: open a bare PTY pair immediately (Unix only)
    if (!isWindows) {
      const result = (native as INativeUnix).open(this._cols, this._rows);
      this.stdin = result.master;
      this.stdout = result.slave;
      this._setupUnixReader(this.stdin);
    }
  }

  get closed(): boolean {
    return this._closed;
  }

  write(data: string | Uint8Array): number {
    if (this._closed) return 0;

    if (isWindows) {
      return this._writeWindows(data);
    }
    return this._writeUnix(data);
  }

  resize(cols: number, rows: number): void {
    if (this._closed) return;
    this._cols = cols;
    this._rows = rows;

    if (isWindows) {
      if (this._winHandle) {
        const doResize = () => this._winNative!.resize(this._winHandle!, cols, rows);
        if (this._winReady) doResize();
        else this._winDeferred.push(doResize);
      }
    } else if (this.stdin >= 0) {
      (native as INativeUnix).resize(this.stdin, cols, rows);
    }
  }

  ref(): void {
    this._readable?.ref();
  }

  unref(): void {
    this._readable?.unref();
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;

    this._wq?.close();

    if (isWindows) {
      this._winDeferred.length = 0;
      if (this._winHandle) {
        try {
          this._winNative!.close(this._winHandle);
        } catch {}
      }
    } else {
      this._destroyReader();
      if (this._standalone) {
        if (this.stdout >= 0) {
          try { fs.closeSync(this.stdout); } catch {}
          this.stdout = -1;
        }
        if (this.stdin >= 0) {
          try { fs.closeSync(this.stdin); } catch {}
        }
      }
      this.stdin = -1;
    }

    this._dataListeners.length = 0;
    this._onExit?.(this, 0, null);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  /** @internal Attach to a fork's master fd (called from UnixTerminal). */
  _attachUnixFd(fd: number): void {
    this._standalone = false;
    this._destroyReader();
    // Close standalone PTY fds if we had them
    if (this.stdout >= 0) {
      try { fs.closeSync(this.stdout); } catch {}
      this.stdout = -1;
    }
    if (this.stdin >= 0) {
      try { fs.closeSync(this.stdin); } catch {}
    }
    this.stdin = fd;
    this._setupUnixReader(fd);
  }

  /** @internal Attach a Windows ConPTY handle (called from WindowsTerminal). */
  _attachWindows(winNative: INativeWindows, handle: object): void {
    this._winNative = winNative;
    this._winHandle = handle;
    this._standalone = false;
  }

  /** @internal Mark Windows terminal as ready and flush deferred calls. */
  _markReady(): void {
    this._winReady = true;
    for (const fn of this._winDeferred) fn();
    this._winDeferred.length = 0;
  }

  /** @internal Emit data from native. */
  _emitData(data: Uint8Array): void {
    this._onData?.(this, data);
    if (this._dataListeners.length > 0) {
      const text = new TextDecoder().decode(data);
      for (const listener of this._dataListeners) {
        listener(text);
      }
    }
  }

  private _destroyReader(): void {
    try {
      this._readable?.destroy();
    } catch {}
    this._readable = undefined;
  }

  private _setupUnixReader(fd: number): void {
    this._readable = new tty.ReadStream(fd);
    this._readable.on("data", (chunk: Buffer) => {
      this._emitData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    this._readable.on("error", () => {});
    this._wq = new WriteQueue(fd, () => this._onDrain?.(this));
  }

  private _writeUnix(data: string | Uint8Array): number {
    return this._wq?.enqueue(data) ?? 0;
  }

  private _writeWindows(data: string | Uint8Array): number {
    if (!this._winHandle) return 0;
    const str = typeof data === "string" ? data : new TextDecoder().decode(data);
    const len = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    const doWrite = () => this._winNative!.write(this._winHandle!, str);
    if (this._winReady) doWrite();
    else this._winDeferred.push(doWrite);
    return len;
  }
}
