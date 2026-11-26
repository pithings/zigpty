import type { ValidResumeReport } from "../osc/types.ts";

/** A resume command a program registered for itself, keyed by owning pid. */
export interface ResumeRecord {
  /** Owning process id (as reported — not necessarily the reporting process). */
  pid: number;
  /** Command to run on resume. `argv[0]` is a bare command name or an absolute path. */
  argv: string[];
  /** Absolute working directory to resume in, when the program reported one. */
  cwd?: string;
  /** Report time, seconds since the Unix epoch. */
  time: number;
}

/** Called after the tracked records change. */
export type ResumeChangeListener = (
  /** Same as {@link ResumeTracker.record} — the record to resume, if any. */
  record: ResumeRecord | undefined,
  /** Same as {@link ResumeTracker.records} — every tracked record, oldest first. */
  records: ResumeRecord[],
) => void;

export interface ResumeTrackerOptions {
  /**
   * Per-pane token placed in `OSC7577_TOKEN`. Must be 22–64 chars of
   * `[A-Za-z0-9_-]` and must never be reused across panes or host restarts.
   * Default: a fresh random token from {@link createResumeToken}.
   */
  token?: string;
  /** Accepted clock skew between a report's `time` and now, in seconds. Default `60`. */
  window?: number;
  /** Clock override for tests. Returns Unix time in **seconds**. Default `Date.now() / 1000`. */
  now?: () => number;
  /**
   * When attached to a PTY whose `stats()` is available, reject reports whose
   * owning `pid` is neither the spawned process nor one of its descendants.
   * Skipped silently when there is no PTY or `stats()` returns `null`.
   * Default `true`.
   */
  validatePid?: boolean;
}

export interface VerifyResumeOptions {
  /** Current Unix time in seconds. Default `Date.now() / 1000`. */
  now?: number;
  /** Accepted clock skew in seconds. Default `60`. */
  window?: number;
  /** `time` of the last report accepted for the same pid — older reports are ignored. */
  lastTime?: number;
}

/**
 * Outcome of {@link verifyResumeReport}, following the spec's terms:
 *
 * - `accepted` — authentic, fresh, and well-formed.
 * - `ignored` — no verifiable `mac`, wrong `mac`, or `time` outside the window /
 *   older than the last accepted report. Must not change any state.
 * - `rejected` — authentic and fresh but malformed. The owner's records must be
 *   removed (`pid` is set when the report has a usable owner).
 */
export type ResumeVerdict =
  | { status: "accepted"; report: ValidResumeReport }
  | { status: "ignored"; reason: string }
  | { status: "rejected"; reason: string; pid?: number };

/** Input for {@link formatResumeReport}. Exactly one of `argv` / `clear`. */
export interface ResumeReportInput {
  /** Owning process id — usually `process.pid`. */
  pid: number;
  /** Resume command. `argv[0]` must be a bare command name or an absolute path. */
  argv?: readonly string[];
  /** Absolute working directory to resume in. */
  cwd?: string;
  /** Send `clear=1` instead of a command — "do not resume me". */
  clear?: boolean;
  /** Unix time in seconds. Default: now. */
  time?: number;
}
