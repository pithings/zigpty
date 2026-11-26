import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decodeResumeReport } from "../osc/decode.ts";
import type { ResumeReport } from "../osc/types.ts";
import type { ResumeReportInput, ResumeVerdict, VerifyResumeOptions } from "./types.ts";

/** Environment variable that carries the per-pane token. */
export const RESUME_TOKEN_ENV = "OSC7577_TOKEN";

const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;

/** Throw unless `token` is 22–64 chars of `[A-Za-z0-9_-]`. */
export function assertResumeToken(token: string): void {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    throw new TypeError("OSC 7577 token must be 22-64 characters of [A-Za-z0-9_-]");
  }
}

/**
 * Generate a fresh OSC 7577 token: 32 base64url chars (192 bits) from the
 * OS CSPRNG. Use one per pane, and a new one every time the host starts.
 */
export function createResumeToken(): string {
  return randomBytes(24).toString("base64url");
}

function computeMac(signed: string, token: string): Buffer {
  return Buffer.from(createHash("sha256").update(`${signed}:${token}`, "utf8").digest("hex"));
}

/**
 * Verify a decoded OSC 7577 report against a pane's token, following the
 * spec's order: `mac` first, then `time` (window + not older than the last
 * accepted report for the same pid), then the strict grammar.
 *
 * Pass either a decoded {@link ResumeReport} (e.g. from `decodeOSC`) or the
 * raw OSC body (the payload after `7577;`). Pure — does not track state; feed
 * the previous accepted `time` for this pid via `options.lastTime`.
 *
 * @experimental Spec rev 0.5 — https://www.superlogical.com/rex/docs/build/program-resume
 */
export function verifyResumeReport(
  report: ResumeReport | string,
  token: string,
  options: VerifyResumeOptions = {},
): ResumeVerdict {
  const r = typeof report === "string" ? decodeResumeReport(report) : report;
  if (r.mac === undefined || r.signed === undefined) {
    return { status: "ignored", reason: r.valid ? "missing mac" : r.error };
  }
  const expected = computeMac(r.signed, token);
  const actual = Buffer.from(r.mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { status: "ignored", reason: "mac mismatch" };
  }
  if (r.time === undefined) return { status: "ignored", reason: "missing or invalid `time`" };
  const now = options.now ?? Date.now() / 1000;
  const window = options.window ?? 60;
  if (!(Math.abs(r.time - now) <= window)) {
    return { status: "ignored", reason: "`time` outside the accepted window" };
  }
  if (options.lastTime !== undefined && r.time < options.lastTime) {
    return { status: "ignored", reason: "`time` is older than the last accepted report" };
  }
  if (!r.valid) {
    return r.pid === undefined
      ? { status: "rejected", reason: r.error }
      : { status: "rejected", reason: r.error, pid: r.pid };
  }
  return { status: "accepted", report: r };
}

/**
 * Build a complete OSC 7577 report (`ESC ] 7577 ; … ST`) — the program side
 * of the protocol. Read the token from `process.env.OSC7577_TOKEN`; when it's
 * absent the terminal doesn't support resume, so don't report.
 *
 * Throws a `TypeError` when the input cannot be reported (bad token, both or
 * neither of `argv`/`clear`, relative program/cwd, control characters, …).
 *
 * @example
 * ```ts
 * const token = process.env.OSC7577_TOKEN;
 * if (token) {
 *   process.stdout.write(
 *     formatResumeReport({ pid: process.pid, argv: ["myapp", "--session", id] }, token),
 *   );
 * }
 * ```
 *
 * @experimental Spec rev 0.5 — https://www.superlogical.com/rex/docs/build/program-resume
 */
export function formatResumeReport(input: ResumeReportInput, token: string): string {
  assertResumeToken(token);
  const time = input.time ?? Math.floor(Date.now() / 1000);
  if (input.clear && input.argv) {
    throw new TypeError("OSC 7577 report must have exactly one of `argv` and `clear`");
  }
  if (!input.clear && !input.argv) {
    throw new TypeError("OSC 7577 report needs `argv` or `clear: true`");
  }
  if (input.clear && input.cwd !== undefined) {
    throw new TypeError("OSC 7577 `cwd` only applies to `argv` reports");
  }
  let body = `pid=${input.pid}:time=${time}`;
  if (input.clear) {
    body += ":clear=1";
  } else {
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    body += `:argv=${input.argv!.map(b64).join(",")}`;
    if (input.cwd !== undefined) body += `:cwd=${b64(input.cwd)}`;
  }
  const mac = computeMac(body, token).toString("ascii");
  const payload = `${body}:mac=${mac}`;
  const check = decodeResumeReport(payload);
  if (!check.valid) throw new TypeError(`Cannot format OSC 7577 report: ${check.error}`);
  return `\x1b]7577;${payload}\x1b\\`;
}
