import type { INativeWindows } from "../napi.ts";
import type { IPtyOptions, IPtyStats } from "./types.ts";
import { BasePty, DEFAULT_COLS, DEFAULT_ROWS, buildEnvPairs } from "./_base.ts";

export class WindowsPty extends BasePty {
  private _handle: object;
  private _native: INativeWindows;
  private _file: string;
  private _encoding: BufferEncoding | null;
  private _deferredCalls: Array<() => void> = [];
  private _ready = false;

  constructor(native: INativeWindows, file: string, args: string[], options?: IPtyOptions) {
    const cols = options?.cols ?? DEFAULT_COLS;
    const rows = options?.rows ?? DEFAULT_ROWS;
    super(cols, rows, options);

    this._native = native;
    this._file = file;
    this._encoding = options?.encoding !== undefined ? options.encoding : "utf8";

    const cwd = options?.cwd ?? process.cwd();
    const envObj = options?.env ?? process.env;
    const envPairs = buildEnvPairs(envObj, options?.name);

    const result = native.spawn(
      file,
      args,
      envPairs,
      cwd,
      cols,
      rows,
      (data: Buffer) => {
        // First data received — ConPTY is ready, flush deferred calls
        if (!this._ready) {
          this._ready = true;
          if (this._closed) return;
          if (this._terminal) {
            this._terminal._markReady();
          }
          const deferred = [...this._deferredCalls];
          this._deferredCalls.length = 0;
          for (const fn of deferred) fn();
        }
        if (this._closed) return;

        // Emit to terminal callbacks
        if (this._terminal) {
          this._terminal._emitData(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        }

        const output = this._encoding ? data.toString(this._encoding) : data;
        for (const listener of this._dataListeners) {
          listener(output);
        }
      },
      (info) => {
        this._handleExit(info);
      },
    );

    this.pid = result.pid;
    this._handle = result.handle;

    if (this._terminal) {
      this._terminal._attachWindows(native, result.handle);
    }
  }

  get process(): string {
    return this._file;
  }

  stats(): IPtyStats | null {
    if (this._closed) return null;
    try {
      return this._native.stats(this._handle) ?? null;
    } catch {
      return null;
    }
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
    // Kill the process — the exit monitor thread handles ClosePseudoConsole
    // and cleanup. Calling native.close() from the JS thread can deadlock
    // because ClosePseudoConsole blocks until the output pipe is drained,
    // but the tsfn callback needs the JS thread to fire.
    try {
      this._native.kill(this._handle);
    } catch {}
  }
}
