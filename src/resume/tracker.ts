import type { Buffer } from "node:buffer";
import { decodeResumeReport } from "../osc/decode.ts";
import { OSCInspector } from "../osc/inspector.ts";
import type { ResumeReport } from "../osc/types.ts";
import type { IPty, IPtyConsumer } from "../pty/types.ts";
import {
  assertResumeToken,
  createResumeToken,
  RESUME_TOKEN_ENV,
  verifyResumeReport,
} from "./protocol.ts";
import type { ResumeChangeListener, ResumeRecord, ResumeTrackerOptions } from "./types.ts";

/**
 * Terminal side of the Program Resume Protocol (OSC 7577).
 *
 * Owns one pane's token, watches the PTY output for resume reports, verifies
 * them (`mac`, `time` window, monotonic `time` per pid, strict grammar) and
 * keeps the resulting records keyed by owning pid. Persisting records and
 * actually restoring programs is left to the host application.
 *
 * Use one tracker per pane — the spec forbids sharing tokens.
 *
 * @example
 * ```ts
 * const resume = new ResumeTracker();
 * const pty = spawn(shell, [], { env: { ...process.env, ...resume.env } });
 * pty.attach(resume);
 * resume.onChange((record) => save(paneId, record));
 * ```
 *
 * @experimental Spec rev 0.5 — https://www.superlogical.com/rex/docs/build/program-resume
 */
export class ResumeTracker implements IPtyConsumer {
  private readonly _token: string;
  private readonly _window: number;
  private readonly _now: () => number;
  private readonly _validatePid: boolean;
  // Insertion order doubles as recency: updates delete + re-insert.
  private readonly _records = new Map<number, ResumeRecord>();
  // Last accepted `time` per pid. Kept after a record is removed so an older
  // report can't be replayed inside the window to bring it back.
  private readonly _lastTime = new Map<number, number>();
  private readonly _listeners: ResumeChangeListener[] = [];
  private readonly _inspector: OSCInspector;
  private _pty: IPty | undefined;

  constructor(options: ResumeTrackerOptions = {}) {
    if (options.token !== undefined) assertResumeToken(options.token);
    this._token = options.token ?? createResumeToken();
    this._window = options.window ?? 60;
    this._now = options.now ?? (() => Date.now() / 1000);
    this._validatePid = options.validatePid ?? true;
    this._inspector = new OSCInspector((event) => {
      if (event.code === 7577) this._handle(decodeResumeReport(event.payload));
    });
  }

  /** This pane's token. Only ever hand it to the pane's first process. */
  get token(): string {
    return this._token;
  }

  /** `{ OSC7577_TOKEN: token }` — spread into the spawn env (after `process.env`). */
  get env(): { OSC7577_TOKEN: string } {
    return { [RESUME_TOKEN_ENV]: this._token } as { OSC7577_TOKEN: string };
  }

  /**
   * The record to resume, if any: the attached PTY's own process when it has
   * a record (an ancestor wins over its descendants), otherwise the most
   * recently accepted one.
   */
  get record(): ResumeRecord | undefined {
    const leader = this._pty ? this._records.get(this._pty.pid) : undefined;
    if (leader) return copy(leader);
    let last: ResumeRecord | undefined;
    for (const r of this._records.values()) last = r;
    return last ? copy(last) : undefined;
  }

  /** Every tracked record, oldest first. */
  get records(): ResumeRecord[] {
    return [...this._records.values()].map(copy);
  }

  /** Subscribe to record changes. Returns an unsubscribe function. */
  onChange(listener: ResumeChangeListener): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  /**
   * Drop every record. Call when the user deliberately closes the pane (not
   * when the host quits). Always notifies listeners — even if nothing was
   * tracked — so persistence hooks can delete a saved record.
   */
  clear(): void {
    this._records.clear();
    this._emit();
  }

  /** Feed PTY output. Accepts string (utf-8), Buffer, or Uint8Array. */
  feed(data: string | Buffer | Uint8Array): void {
    this._inspector.feed(data);
  }

  /** Called by `pty.attach()` — enables pid validation and leader preference. */
  onAttach(pty: IPty): void {
    this._pty = pty;
  }

  /**
   * Called on detach / PTY exit. Records are kept: a PTY exiting because the
   * host is shutting down is exactly when they are needed.
   */
  onDetach(_pty: IPty): void {
    this._pty = undefined;
  }

  /** Drop listeners and records, and stop parsing. */
  dispose(): void {
    this._listeners.length = 0;
    this._records.clear();
    this._lastTime.clear();
    this._inspector.dispose();
    this._pty = undefined;
  }

  private _handle(report: ResumeReport): void {
    const verdict = verifyResumeReport(report, this._token, {
      now: this._now(),
      window: this._window,
      lastTime: report.pid === undefined ? undefined : this._lastTime.get(report.pid),
    });
    if (verdict.status === "ignored") return;
    if (verdict.status === "rejected") {
      if (verdict.pid !== undefined) this._remove(verdict.pid);
      return;
    }
    const r = verdict.report;
    if (this._validatePid && !this._ownsPid(r.pid)) {
      this._remove(r.pid);
      return;
    }
    this._lastTime.set(r.pid, r.time);
    if (r.clear) {
      this._remove(r.pid);
      return;
    }
    const record: ResumeRecord = { pid: r.pid, argv: r.argv!, time: r.time };
    if (r.cwd !== undefined) record.cwd = r.cwd;
    this._records.delete(r.pid);
    this._records.set(r.pid, record);
    this._emit();
  }

  // Owner must be the PTY's process or a descendant. Skipped when not
  // attached or the platform can't look processes up.
  private _ownsPid(pid: number): boolean {
    const pty = this._pty;
    if (!pty) return true;
    let stats: ReturnType<IPty["stats"]>;
    try {
      stats = pty.stats();
    } catch {
      return true;
    }
    if (!stats) return true;
    return stats.pid === pid || stats.children.some((c) => c.pid === pid);
  }

  private _remove(pid: number): void {
    if (this._records.delete(pid)) this._emit();
  }

  private _emit(): void {
    const record = this.record;
    for (const l of this._listeners) {
      try {
        l(record, this.records);
      } catch {
        // Swallow listener errors — never let one break the data path.
      }
    }
  }
}

function copy(r: ResumeRecord): ResumeRecord {
  return r.cwd === undefined
    ? { pid: r.pid, argv: [...r.argv], time: r.time }
    : { pid: r.pid, argv: [...r.argv], cwd: r.cwd, time: r.time };
}
