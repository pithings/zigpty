import * as os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { native as _native } from "../napi.ts";
import type { INativeUnix } from "../napi.ts";

const native = _native as INativeUnix;
import type { IPtyOptions, IPtyStats } from "./types.ts";
import { BasePty, DEFAULT_COLS, DEFAULT_ROWS, buildEnvPairs } from "./_base.ts";
import { WriteQueue } from "./_writeQueue.ts";

// Default flow control characters
const DEFAULT_FLOW_PAUSE = "\x13"; // XOFF
const DEFAULT_FLOW_RESUME = "\x11"; // XON

const UNIX_SANITIZE_KEYS = [
  "TMUX",
  "TMUX_PANE",
  "STY",
  "WINDOW",
  "WINDOWID",
  "TERMCAP",
  "COLUMNS",
  "LINES",
];

export class UnixPty extends BasePty {
  private _fd: number;
  private _handle: object;
  private _pty: string;
  private _encoding: BufferEncoding | null;
  private _decoder?: StringDecoder;
  private _flowControlPause: string;
  private _flowControlResume: string;
  private _wq: WriteQueue;

  constructor(file: string, args: string[], options?: IPtyOptions) {
    const cols = options?.cols ?? DEFAULT_COLS;
    const rows = options?.rows ?? DEFAULT_ROWS;
    super(cols, rows, options);

    const cwd = options?.cwd ?? process.cwd();
    const encoding = options?.encoding !== undefined ? options.encoding : "utf8";
    const uid = options?.uid ?? -1;
    const gid = options?.gid ?? -1;
    const useUtf8 = encoding === "utf8";

    const envObj = options?.env ?? process.env;
    const envPairs = buildEnvPairs(envObj, options?.name, UNIX_SANITIZE_KEYS);
    this._encoding = encoding;
    this._decoder = encoding ? new StringDecoder(encoding) : undefined;
    this._flowControlPause = options?.flowControlPause ?? DEFAULT_FLOW_PAUSE;
    this._flowControlResume = options?.flowControlResume ?? DEFAULT_FLOW_RESUME;

    const result = native.fork(
      file,
      args,
      envPairs,
      cwd,
      cols,
      rows,
      uid,
      gid,
      useUtf8,
      (event) => {
        if (Buffer.isBuffer(event)) {
          if (!this._closed) this._emitData(event);
          return;
        }

        this._finishExit(event);
      },
    );

    this.pid = result.pid;
    this._fd = result.fd;
    this._handle = result.handle;
    this._pty = result.pty;
    this._wq = new WriteQueue(this._fd);

    if (this._terminal) {
      this._terminal._attachUnixFd(this._fd);
    }
  }

  get process(): string {
    try {
      return native.process(this._fd) ?? "";
    } catch {
      return "";
    }
  }

  stats(): IPtyStats | null {
    if (this._closed) return null;
    try {
      return native.stats(this.pid) ?? null;
    } catch {
      return null;
    }
  }

  write(data: string): void {
    if (this._closed) return;
    this._wq.enqueue(data, this._encoding);
  }

  resize(cols: number, rows: number, pixelSize?: { width: number; height: number }): void {
    if (this._closed) return;
    this.cols = cols;
    this.rows = rows;
    native.resize(this._fd, cols, rows, pixelSize?.width ?? 0, pixelSize?.height ?? 0);
    this._notifyResize(cols, rows);
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
    if (!this._closed) native.pause(this._handle);
  }

  resume(): void {
    if (!this._closed) native.resume(this._handle);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;

    this._wq.close();
    native.close(this._handle);
  }

  private _finishExit(info: { exitCode: number; signal: number }): void {
    const trailing = this._decoder?.end();
    if (trailing && !this._closed) this._emitOutput(trailing);
    this._wq.close();
    this._handleExit(info);
  }

  private _emitData(data: Buffer): void {
    if (this._terminal && !this._terminal.closed) {
      this._terminal._emitData(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }

    const output = this._decoder ? this._decoder.write(data) : data;
    this._emitOutput(output);
  }

  private _emitOutput(output: string | Buffer): void {
    if (output.length === 0) return;
    if (
      this.handleFlowControl &&
      typeof output === "string" &&
      (output === this._flowControlPause || output === this._flowControlResume)
    ) {
      return;
    }
    for (const listener of this._dataListeners) {
      listener(output);
    }
  }
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
