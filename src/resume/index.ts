/**
 * Program Resume Protocol (OSC 7577) — experimental, spec rev 0.5.
 * https://www.superlogical.com/rex/docs/build/program-resume
 *
 * - {@link ResumeTracker} — per-pane token + verified resume records (`IPtyConsumer`)
 * - {@link verifyResumeReport} — pure mac/time/grammar check for one report
 * - {@link formatResumeReport} — program side: build a signed report
 * - {@link createResumeToken} — CSPRNG token generator
 */
export { ResumeTracker } from "./tracker.ts";
export {
  createResumeToken,
  formatResumeReport,
  RESUME_TOKEN_ENV,
  verifyResumeReport,
} from "./protocol.ts";
export type {
  ResumeChangeListener,
  ResumeRecord,
  ResumeReportInput,
  ResumeTrackerOptions,
  ResumeVerdict,
  VerifyResumeOptions,
} from "./types.ts";
export type { InvalidResumeReport, ResumeReport, ValidResumeReport } from "../osc/types.ts";
