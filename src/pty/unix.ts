import * as fs from "node:fs";
import * as os from "node:os";
import * as tty from "node:tty";
import { native as _native } from "../napi.ts";
import type { INativeUnix } from "../napi.ts";

const native = _native as INativeUnix;
import type { IPtyOptions } from "./types.ts";
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
  private _pty: string;
  private _readable: tty.ReadStream | undefined;
  private _encoding: BufferEncoding | null;
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

    const result = native.fork(file, args, envPairs, cwd, cols, rows, uid, gid, useUtf8, (info) => {
      this._handleExit(info);
      try {
        this._readable?.destroy();
      } catch {}
    });

    this.pid = result.pid;
    this._fd = result.fd;
    this._pty = result.pty;
    this._encoding = encoding;
    this._flowControlPause = options?.flowControlPause ?? DEFAULT_FLOW_PAUSE;
    this._flowControlResume = options?.flowControlResume ?? DEFAULT_FLOW_RESUME;
    this._wq = new WriteQueue(this._fd);

    // When a Terminal is attached, it owns the ReadStream on this fd.
    // Only create our own ReadStream when there's no terminal.
    if (this._terminal) {
      this._terminal._attachUnixFd(this._fd);
      // Use a dummy ReadStream ref for pause/resume/destroy in exit handler
      this._readable = undefined!;
    } else {
      // Create readable stream from master fd
      this._readable = new tty.ReadStream(this._fd);
      if (encoding) {
        this._readable.setEncoding(encoding);
      }
      this._readable.on("data", (data: string | Buffer) => {
        if (this.handleFlowControl && typeof data === "string") {
          if (data === this._flowControlPause || data === this._flowControlResume) return;
        }
        for (const listener of this._dataListeners) {
          listener(data);
        }
      });
      this._readable.on("error", () => {});
    }
  }

  get process(): string {
    try {
      return native.process(this._fd) ?? "";
    } catch {
      return "";
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
    this._readable?.pause();
  }

  resume(): void {
    this._readable?.resume();
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;

    this._wq.close();

    try {
      this._readable?.destroy();
    } catch {}

    try {
      fs.closeSync(this._fd);
    } catch {}

    try {
      process.kill(this.pid, 0);
      process.kill(this.pid, "SIGHUP");
    } catch {}
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
