/**
 * Implicit terminal-attention detection.
 *
 * - {@link ActivityDetector} — byte-fed state machine; emits `idle` when an
 *   output burst stops (likely meaning an interactive agent is waiting for input).
 */
export { ActivityDetector } from "./detector.ts";
export type {
  ActivityDetectorOptions,
  ActivityEvent,
  ActivityListener,
  ActivityState,
} from "./types.ts";
