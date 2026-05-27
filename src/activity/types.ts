/** Activity state — either nothing meaningful is flowing, or output is in flight. */
export type ActivityState = "idle" | "active";

/** Emitted on every state transition. */
export interface ActivityEvent {
  /** New state after the transition. */
  type: ActivityState;
  /** Significant content bytes (ANSI/control bytes excluded) accumulated during the previous state. */
  bytes: number;
  /** How long the previous state lasted, in ms. */
  durationMs: number;
}

/** Listener for activity transitions. */
export type ActivityListener = (event: ActivityEvent) => void;

export interface ActivityDetectorOptions {
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
}
