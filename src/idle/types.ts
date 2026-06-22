/** Detector state — either nothing meaningful is flowing, or output is in flight. */
export type IdleState = "idle" | "active";

/** Emitted on every state transition. */
export interface IdleEvent {
  /** New state after the transition. */
  type: IdleState;
  /** Significant content bytes (ANSI/control bytes excluded) accumulated for the output burst. */
  bytes: number;
  /** How long the previous state lasted, in ms. */
  durationMs: number;
}

/** Listener for idle-detector transitions. */
export type IdleListener = (event: IdleEvent) => void;

export interface IdleDetectorOptions {
  /**
   * Quiet period (ms) with no significant bytes before transitioning
   * `active` → `idle`. This is the main "attention" signal — when output
   * stops, the agent is likely done or waiting for input. Default `750`.
   */
  quietMs?: number;
  /**
   * Minimum significant bytes in a single burst (gaps shorter than
   * `quietMs`) before transitioning `idle` → `active`. Tiny status-bar
   * updates and cursor-blink redraws fall below this. Default `512`.
   */
  activeThreshold?: number;
  /**
   * Grace period (ms) after attach during which significant bytes are
   * silently absorbed without firing `active`. Filters out the initial
   * shell-prompt / banner flood. Default `1500`.
   */
  graceMs?: number;
  /**
   * Suppression window (ms) opened by {@link IdleDetector.suppress} — and
   * automatically on PTY resize — during which significant bytes are
   * silently absorbed. Filters out the full-screen repaint a TUI emits
   * after a resize or an explicit redraw (`^L`), which would otherwise look
   * like a fresh burst of agent output. Default `500`.
   */
  redrawGraceMs?: number;
}
