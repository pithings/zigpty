/**
 * Implicit terminal-attention detection.
 *
 * - {@link IdleDetector} — byte-fed state machine; emits `idle` when an
 *   output burst stops (likely meaning an interactive agent is waiting for input).
 */
export { IdleDetector } from "./detector.ts";
export type { IdleDetectorOptions, IdleEvent, IdleListener, IdleState } from "./types.ts";
