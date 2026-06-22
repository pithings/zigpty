import { Buffer } from "node:buffer";
import type { IPty, IPtyConsumer } from "../pty/types.ts";
import type { IdleDetectorOptions, IdleEvent, IdleListener, IdleState } from "./types.ts";

const Ground = 0;
const Esc = 1;
const Csi = 2;
const Osc = 3;
const OscSt = 4;
type EscState = 0 | 1 | 2 | 3 | 4;

/**
 * Implicit terminal-attention detector.
 *
 * Watches a PTY's byte stream and emits an `idle` event when output stops
 * after a burst of meaningful activity — typically meaning an interactive
 * AI agent or REPL is done streaming and waiting for input.
 *
 * Designed to suppress common false positives:
 * - **Startup flood**: bytes arriving within `graceMs` of attach are
 *   silently absorbed (shell init, banner, first prompt).
 * - **Tiny UI updates**: status bars and cursor-blink redraws fall below
 *   `activeThreshold` (significant bytes per burst) and never enter active.
 * - **ANSI/CSI/OSC sequences**: only printable content counts toward the
 *   threshold, so heavy color/escape output doesn't masquerade as text.
 * - **Resize / redraw repaints**: bytes arriving within `redrawGraceMs` of a
 *   PTY resize (auto) or an explicit {@link suppress} call (e.g. before
 *   sending `^L`) are absorbed — a full-screen repaint isn't fresh output.
 *
 * @example
 * ```ts
 * const det = new IdleDetector((e) => {
 *   if (e.type === "idle") console.log("agent likely waiting for input");
 * });
 * pty.attach(det);
 * ```
 */
export class IdleDetector implements IPtyConsumer {
  private _state: IdleState = "idle";
  private _bytesPending = 0;
  private _stateStart: number;
  private _attachAt: number;
  private _lastSigTime: number;
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _escState: EscState = Ground;
  private _suppressUntil = 0;
  private _listeners: IdleListener[] = [];
  private readonly _quietMs: number;
  private readonly _activeThreshold: number;
  private readonly _graceMs: number;
  private readonly _redrawGraceMs: number;

  constructor(listener?: IdleListener, options: IdleDetectorOptions = {}) {
    this._quietMs = options.quietMs ?? 750;
    this._activeThreshold = options.activeThreshold ?? 512;
    this._graceMs = options.graceMs ?? 1500;
    this._redrawGraceMs = options.redrawGraceMs ?? 500;
    const now = Date.now();
    this._stateStart = now;
    this._attachAt = now;
    this._lastSigTime = now;
    if (listener) this._listeners.push(listener);
  }

  /** Subscribe to idle/active transitions. Returns a disposer. */
  on(listener: IdleListener): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  /** Current state (`idle` initially). */
  get state(): IdleState {
    return this._state;
  }

  /** Reset the grace window — called automatically by `pty.attach()`. */
  onAttach(_pty: IPty): void {
    const now = Date.now();
    this._attachAt = now;
    this._stateStart = now;
    this._lastSigTime = now;
  }

  onDetach(_pty: IPty): void {
    this.dispose();
  }

  /**
   * Auto-called by `pty.attach()` wiring whenever the PTY is resized. Opens a
   * suppression window so the TUI's full-screen repaint isn't counted as a
   * fresh activity burst.
   */
  onResize(_cols: number, _rows: number): void {
    this.suppress();
  }

  /**
   * Open a suppression window of `durationMs` (default `redrawGraceMs`).
   * Significant bytes arriving within it are absorbed silently — they never
   * push the detector into `active`, nor keep an active burst alive. Call this
   * right before sending an explicit redraw (e.g. `^L`) so the repaint that
   * follows isn't mistaken for new output. Resize triggers it automatically.
   */
  suppress(durationMs: number = this._redrawGraceMs): void {
    this._suppressUntil = Date.now() + durationMs;
  }

  /** Feed bytes into the detector. Accepts string (utf-8), Buffer, or Uint8Array. */
  feed(data: string | Buffer | Uint8Array): void {
    const buf =
      typeof data === "string"
        ? Buffer.from(data, "utf8")
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const sig = this._countSignificant(buf);
    if (sig === 0) return;

    const now = Date.now();

    // Inside a resize/redraw suppression window — absorb the repaint without
    // counting it toward a burst (idle) or keeping one alive (active).
    if (now < this._suppressUntil) {
      this._lastSigTime = now;
      return;
    }

    if (this._state === "idle") {
      // Within startup grace — silently absorb, never fire active.
      if (now - this._attachAt < this._graceMs) {
        this._lastSigTime = now;
        return;
      }
      // Burst window expired — start a fresh accumulation. This is what
      // prevents tiny periodic updates (status bar, clock) from slowly
      // adding up to the threshold over many seconds.
      if (now - this._lastSigTime > this._quietMs) {
        this._bytesPending = 0;
      }
      this._lastSigTime = now;
      this._bytesPending += sig;
      if (this._bytesPending >= this._activeThreshold) {
        const prevBytes = this._bytesPending;
        const prevDuration = now - this._stateStart;
        this._state = "active";
        this._stateStart = now;
        this._emit({ type: "active", bytes: prevBytes, durationMs: prevDuration });
        this._scheduleIdle();
      }
    } else {
      this._lastSigTime = now;
      this._bytesPending += sig;
      this._scheduleIdle();
    }
  }

  /** Drop all listeners and reset internal state. */
  dispose(): void {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    this._listeners.length = 0;
    this._state = "idle";
    this._bytesPending = 0;
    this._escState = Ground;
    this._suppressUntil = 0;
  }

  private _scheduleIdle(): void {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    const timer = setTimeout(() => {
      this._idleTimer = null;
      const now = Date.now();
      const prevBytes = this._bytesPending;
      const prevDuration = now - this._stateStart;
      this._state = "idle";
      this._bytesPending = 0;
      this._stateStart = now;
      this._emit({ type: "idle", bytes: prevBytes, durationMs: prevDuration });
    }, this._quietMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this._idleTimer = timer;
  }

  // Walks bytes and skips anything that isn't user-visible content. State
  // persists across calls so an ESC sequence split across feeds is still
  // recognised on the second chunk.
  private _countSignificant(buf: Buffer): number {
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i]!;
      switch (this._escState) {
        case Ground:
          if (b === 0x1b) {
            this._escState = Esc;
          } else if (b === 0x0a || b === 0x09) {
            count++;
          } else if (b >= 0x20 && b !== 0x7f) {
            count++;
          }
          break;
        case Esc:
          if (b === 0x5b) this._escState = Csi;
          else if (b === 0x5d) this._escState = Osc;
          else this._escState = Ground;
          break;
        case Csi:
          if (b >= 0x40 && b <= 0x7e) this._escState = Ground;
          break;
        case Osc:
          // OSC terminates on BEL or ST (ESC \). A stray ESC can also be
          // the start of a following escape sequence, so keep a dedicated
          // intermediate state instead of falling back to generic ESC.
          if (b === 0x07) this._escState = Ground;
          else if (b === 0x1b) this._escState = OscSt;
          break;
        case OscSt:
          if (b === 0x5c) {
            this._escState = Ground;
          } else if (b === 0x1b) {
            // Abort current OSC, but treat this ESC as the start of a
            // possible next sequence (same recovery strategy as OSCInspector).
            this._escState = Esc;
          } else {
            this._escState = Ground;
          }
          break;
      }
    }
    return count;
  }

  private _emit(event: IdleEvent): void {
    for (const l of this._listeners) {
      try {
        l(event);
      } catch {
        // Swallow listener errors — never let one break detection.
      }
    }
  }
}
