import type { INativeWindows } from "./napi.ts";
import type { IDisposable, IEvent, IPty, IPtyOptions } from "./types.ts";
import { Terminal } from "./terminal.ts";
import type { TerminalOptions } from "./terminal.ts";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export class WindowsTerminal implements IPty {
  pid: number;
  cols: number;
  rows: number;
  handleFlowControl: boolean;

  private _handle: object;
  private _native: INativeWindows;
  private _file: string;
  private _encoding: BufferEncoding | null;
  private _dataListeners: Array<(data: string | Buffer) => void> = [];
  private _exitListeners: Array<(info: { exitCode: number; signal: number }) => void> = [];
  private _closed = false;
  private _deferredCalls: Array<() => void> = [];
  private _ready = false;
  private _exitCode: number | null = null;
  private _resolveExited!: (code: number) => void;
  private _exited: Promise<number>;
  private _terminal?: Terminal;

  constructor(native: INativeWindows, file: string, args: string[], options?: IPtyOptions) {
    const cols = options?.cols ?? DEFAULT_COLS;
    const rows = options?.rows ?? DEFAULT_ROWS;
    const cwd = options?.cwd ?? process.cwd();
    const encoding = options?.encoding !== undefined ? options.encoding : "utf8";

    this._exited = new Promise<number>((resolve) => {
      this._resolveExited = resolve;
    });

    this._native = native;
    this._file = file;
    this._encoding = encoding;
    this.cols = cols;
    this.rows = rows;
    this.handleFlowControl = options?.handleFlowControl ?? false;

    // Set up terminal if provided
    if (options?.terminal) {
      this._terminal =
        options.terminal instanceof Terminal
          ? options.terminal
          : new Terminal(options.terminal as TerminalOptions);
    }

    // Build env pairs
    const envObj = options?.env ?? (process.env as Record<string, string>);
    const envPairs = buildEnvPairs(envObj, options?.name);

    const result = native.spawn(file, args, envPairs, cwd, cols, rows, (data: Buffer) => {
      // First data received — ConPTY is ready, flush deferred calls
      if (!this._ready) {
        this._ready = true;
        if (this._terminal) {
          this._terminal._markReady();
        }
        for (const fn of this._deferredCalls) fn();
        this._deferredCalls.length = 0;
      }

      // Emit to terminal callbacks
      if (this._terminal) {
        this._terminal._emitData(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }

      const output = this._encoding ? data.toString(this._encoding) : data;
      for (const listener of this._dataListeners) {
        listener(output);
      }
    }, (info) => {
      this._closed = true;
      this._exitCode = info.exitCode;
      options?.onExit?.(info.exitCode, info.signal);
      for (const listener of this._exitListeners) {
        listener(info);
      }
      this._resolveExited(info.exitCode);
    });

    this.pid = result.pid;
    this._handle = result.handle;

    if (this._terminal) {
      this._terminal._attachWindows(native, result.handle);
    }
  }

  get exited(): Promise<number> {
    return this._exited;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get process(): string {
    // Windows: no easy foreground process name, return initial file
    return this._file;
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
    const doWrite = () => this._native.write(this._handle, data);
    if (this._ready) {
      doWrite();
    } else {
      this._deferredCalls.push(doWrite);
    }
  }

  resize(cols: number, rows: number): void {
    if (this._closed) return;
    this.cols = cols;
    this.rows = rows;
    const doResize = () => this._native.resize(this._handle, cols, rows);
    if (this._ready) {
      doResize();
    } else {
      this._deferredCalls.push(doResize);
    }
  }

  clear(): void {
    // TODO: ClearPseudoConsole support (Windows 10 1903+)
  }

  kill(): void {
    if (this._closed) return;
    this._native.kill(this._handle);
  }

  pause(): void {
    // No-op on Windows (data comes from native callback)
  }

  resume(): void {
    // No-op on Windows
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._deferredCalls.length = 0;
    try {
      this._native.close(this._handle);
    } catch {}
  }
}

function buildEnvPairs(env: Record<string, string | undefined>, termName?: string): string[] {
  const pairs: string[] = [];
  const envCopy = { ...env };

  if (termName && !envCopy.TERM) {
    envCopy.TERM = termName;
  }

  for (const [key, value] of Object.entries(envCopy)) {
    if (value !== undefined) {
      pairs.push(`${key}=${value}`);
    }
  }
  return pairs;
}
