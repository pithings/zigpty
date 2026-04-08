/**
 * Pipe-based PTY fallback.
 *
 * Used when native PTY bindings are unavailable (containers without /dev/ptmx,
 * minimal libc without forkpty/openpty, or environments where the Zig prebuilds
 * can't load). Spawns the child with plain pipes instead of a pseudo-terminal.
 *
 * Emulates terminal behavior where possible:
 *   - Signal character translation (^C→SIGINT, ^\→SIGQUIT, ^D→EOF)
 *   - XON/XOFF flow control interception
 *   - Force-color env hints (FORCE_COLOR, COLORTERM)
 *   - SIGWINCH on resize (best-effort)
 *   - Userspace echo + canonical mode (line discipline)
 *
 * Remaining trade-offs vs a real PTY:
 *   - Programs see `isatty()` → false
 *   - No kernel-level TIOCSWINSZ (SIGWINCH is sent but ioctl returns stale size)
 *   - Echo/canonical mode is approximate — no full VT input handling
 *   - ^Z (SIGTSTP) is not translated — no controlling terminal to resume from
 */
import { spawn as cpSpawn, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import type { IPtyOptions } from "./types.ts";
import { BasePty, DEFAULT_COLS, DEFAULT_ROWS } from "./_base.ts";

// Signal character → signal name mapping
const SIGNAL_CHARS: Record<number, NodeJS.Signals> = {
  0x03: "SIGINT", // ^C
  0x1c: "SIGQUIT", // ^\
};
const EOF_CHAR = 0x04; // ^D

// Flow control
const XOFF = 0x13; // ^S — pause
const XON = 0x11; // ^Q — resume

// Line editing control chars for canonical mode
const CHAR_BACKSPACE = 0x7f;
const CHAR_DEL = 0x08;
const CHAR_WORD_ERASE = 0x17; // ^W
const CHAR_LINE_KILL = 0x15; // ^U
const CHAR_REPRINT = 0x12; // ^R
const CHAR_CR = 0x0d; // \r
const CHAR_LF = 0x0a; // \n

export class PipePty extends BasePty {
  private _child: ChildProcess;
  private _file: string;
  private _encoding: BufferEncoding | null;
  private _paused = false;

  // Canonical mode (userspace line discipline)
  private _canonicalMode = true;
  private _echoEnabled = true;
  private _lineBuffer = "";

  constructor(file: string, args: string[], options?: IPtyOptions) {
    const cols = options?.cols ?? DEFAULT_COLS;
    const rows = options?.rows ?? DEFAULT_ROWS;
    super(cols, rows, options);

    this._file = file;
    this._encoding = options?.encoding !== undefined ? options.encoding : "utf8";

    const cwd = options?.cwd ?? process.cwd();
    const envObj = options?.env ?? process.env;

    // Build env as a plain object (child_process wants Record<string,string>)
    const env: Record<string, string> = {};
    const termName = options?.name ?? "xterm-256color";
    for (const [key, value] of Object.entries(envObj)) {
      if (value !== undefined) env[key] = value;
    }
    if (!env.TERM) env.TERM = termName;
    env.COLUMNS = String(cols);
    env.LINES = String(rows);

    // Force-color hints so CLI tools colorize despite isatty()=false
    if (!env.FORCE_COLOR) env.FORCE_COLOR = "1";
    if (!env.COLORTERM) env.COLORTERM = "truecolor";

    const spawnOpts: Parameters<typeof cpSpawn>[2] = {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    };

    if (options?.uid !== undefined) (spawnOpts as any).uid = options.uid;
    if (options?.gid !== undefined) (spawnOpts as any).gid = options.gid;

    this._child = cpSpawn(file, args, spawnOpts);
    this.pid = this._child.pid ?? -1;

    // --- Wire up stdout ---
    this._child.stdout?.on("data", (chunk: Buffer) => {
      this._emitData(chunk);
    });

    // --- Wire up stderr (merge into data stream, same as a real PTY) ---
    this._child.stderr?.on("data", (chunk: Buffer) => {
      this._emitData(chunk);
    });

    // --- Suppress EPIPE / error noise ---
    this._child.stdin?.on("error", () => {});
    this._child.stdout?.on("error", () => {});
    this._child.stderr?.on("error", () => {});

    // --- Exit handling ---
    this._child.on("exit", (code, signal) => {
      const exitCode = code ?? -1;
      const sigNum = signal ? (os.constants.signals[signal] ?? 0) : 0;
      this._handleExit({ exitCode, signal: sigNum });
    });

    // If the child fails to spawn at all
    this._child.on("error", () => {
      if (!this._closed) {
        this._handleExit({ exitCode: -1, signal: 0 });
      }
    });
  }

  /** Switch to raw mode (no echo, no line buffering, pass-through). */
  setRawMode(): void {
    this._canonicalMode = false;
    this._echoEnabled = false;
    this._flushLineBuffer();
  }

  /** Switch to canonical (cooked) mode with echo. */
  setCanonicalMode(): void {
    this._canonicalMode = true;
    this._echoEnabled = true;
  }

  get process(): string {
    return this._file;
  }

  write(data: string): void {
    if (this._closed) return;

    const bytes = Buffer.from(data, this._encoding || "utf8");

    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]!;

      // Flow control interception
      if (this.handleFlowControl) {
        if (byte === XOFF) {
          this.pause();
          continue;
        }
        if (byte === XON) {
          this.resume();
          continue;
        }
      }

      // Signal character translation
      const sig = SIGNAL_CHARS[byte];
      if (sig) {
        this._flushLineBuffer();
        try {
          this._child.kill(sig);
        } catch {}
        continue;
      }

      // ^D → close stdin (EOF)
      if (byte === EOF_CHAR) {
        if (this._canonicalMode && this._lineBuffer.length > 0) {
          // ^D with pending input: flush the buffer without newline
          this._writeToChild(this._lineBuffer);
          this._lineBuffer = "";
        } else {
          // ^D with empty buffer: signal EOF
          try {
            this._child.stdin?.end();
          } catch {}
        }
        continue;
      }

      // Canonical mode: buffer input, handle line editing
      if (this._canonicalMode) {
        this._handleCanonicalByte(byte);
        continue;
      }

      // Raw mode: pass through directly
      this._writeToChild(String.fromCharCode(byte));
    }
  }

  resize(cols: number, rows: number): void {
    if (this._closed) return;
    this.cols = cols;
    this.rows = rows;

    // Send SIGWINCH to hint the child to recheck terminal size.
    // The child can't ioctl(TIOCGWINSZ) on a pipe, but programs that
    // re-read COLUMNS/LINES from env or just use the signal as a
    // "please redraw" trigger will partially work.
    if (this.pid > 0) {
      try {
        process.kill(this.pid, "SIGWINCH");
      } catch {}
    }
  }

  clear(): void {
    // No-op
  }

  kill(signal?: string): void {
    if (this._closed) return;
    const sig = signal ?? "SIGHUP";
    try {
      this._child.kill(sig as NodeJS.Signals);
    } catch {}
  }

  pause(): void {
    this._paused = true;
    this._child.stdout?.pause();
    this._child.stderr?.pause();
  }

  resume(): void {
    this._paused = false;
    this._child.stdout?.resume();
    this._child.stderr?.resume();
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;

    try {
      this._child.stdin?.destroy();
    } catch {}
    try {
      this._child.stdout?.destroy();
    } catch {}
    try {
      this._child.stderr?.destroy();
    } catch {}

    try {
      this._child.kill("SIGHUP");
    } catch {}
  }

  private _handleCanonicalByte(byte: number): void {
    // Backspace / DEL — erase last character
    if (byte === CHAR_BACKSPACE || byte === CHAR_DEL) {
      if (this._lineBuffer.length > 0) {
        this._lineBuffer = this._lineBuffer.slice(0, -1);
        if (this._echoEnabled) this._echoText("\b \b");
      }
      return;
    }

    // ^W — word erase (delete back to previous whitespace)
    if (byte === CHAR_WORD_ERASE) {
      const before = this._lineBuffer;
      // Trim trailing spaces, then trim to last space
      let trimmed = before.replace(/\s+$/, "");
      const lastSpace = trimmed.lastIndexOf(" ");
      trimmed = lastSpace >= 0 ? trimmed.slice(0, lastSpace + 1) : "";
      const erased = before.length - trimmed.length;
      this._lineBuffer = trimmed;
      if (this._echoEnabled && erased > 0) {
        this._echoText("\b \b".repeat(erased));
      }
      return;
    }

    // ^U — line kill (erase entire line)
    if (byte === CHAR_LINE_KILL) {
      const len = this._lineBuffer.length;
      this._lineBuffer = "";
      if (this._echoEnabled && len > 0) {
        this._echoText("\b \b".repeat(len));
      }
      return;
    }

    // ^R — reprint current line
    if (byte === CHAR_REPRINT) {
      if (this._echoEnabled && this._lineBuffer.length > 0) {
        this._echoText("\r\n" + this._lineBuffer);
      }
      return;
    }

    // Enter (CR or LF) — flush line to child
    if (byte === CHAR_CR || byte === CHAR_LF) {
      if (this._echoEnabled) this._echoText("\r\n");
      this._writeToChild(this._lineBuffer + "\n");
      this._lineBuffer = "";
      return;
    }

    // Regular character — append to buffer and echo
    const ch = String.fromCharCode(byte);
    this._lineBuffer += ch;
    if (this._echoEnabled) this._echoText(ch);
  }

  /** Echo text back to the data stream (simulates terminal echo). */
  private _echoText(text: string): void {
    const buf = Buffer.from(text, "utf8");
    this._emitData(buf);
  }

  /** Flush any pending line buffer to the child's stdin. */
  private _flushLineBuffer(): void {
    if (this._lineBuffer.length > 0) {
      this._writeToChild(this._lineBuffer + "\n");
      this._lineBuffer = "";
    }
  }

  /** Write a string to the child's stdin. */
  private _writeToChild(data: string): void {
    if (this._child.stdin?.writable) {
      this._child.stdin.write(data, this._encoding || "utf8");
    }
  }

  private _emitData(chunk: Buffer): void {
    if (this._paused) return;

    // Feed terminal callbacks
    if (this._terminal) {
      this._terminal._emitData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }

    // Feed direct listeners
    const output = this._encoding ? chunk.toString(this._encoding) : chunk;
    for (const listener of this._dataListeners) {
      listener(output);
    }
  }
}
