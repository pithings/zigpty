import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decodeOSC } from "../osc/index.ts";
import { BasePty } from "../pty/_base.ts";
import type { IPtyStats } from "../pty/types.ts";
import {
  createResumeToken,
  formatResumeReport,
  ResumeTracker,
  verifyResumeReport,
  type ResumeRecord,
  type ResumeReport,
  type ResumeTrackerOptions,
} from "./index.ts";

// Spec test vectors (rev 0.5, "Examples" section) use this token and time.
const TOKEN = "dummy-token-replace-me";
const T = 1795543200;

const NVIM =
  "pid=74877:time=1795543200:argv=bnZpbQ==,LVM=,L2hvbWUvdXNlci8ubG9jYWwvc3RhdGUvbnZpbS9zZXNzaW9ucy84ZjJjMWQudmlt:mac=9dbb99bfb856749a87563839d7ce9062818d78cf25909db93f309e0cd3b1909b";
const NVIM_CLEAR =
  "pid=74877:time=1795543200:clear=1:mac=c30603369f98fef581a4098be889175b0c74f0641e49f8b25f4326cb38f97c93";
const LAZYGIT =
  "pid=74877:time=1795543200:argv=bGF6eWdpdA==:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==:mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1";
const WRAP =
  "pid=90412:time=1795543200:argv=cmVzdW1lLXdyYXA=,c3No,ZGV2Ym94:mac=e76149d0ba54a83570ffab0583867dacdfa23928ba9d18604f0badea88b62b65";

const NVIM_RECORD: ResumeRecord = {
  pid: 74877,
  argv: ["nvim", "-S", "/home/user/.local/state/nvim/sessions/8f2c1d.vim"],
  time: T,
};

/** Independent mac computation (not the implementation's). */
function sign(body: string, token = TOKEN): string {
  const mac = createHash("sha256").update(`${body}:${token}`).digest("hex");
  return `${body}:mac=${mac}`;
}

const osc = (body: string, st: "st" | "bel" = "st") =>
  `\x1b]7577;${body}${st === "st" ? "\x1b\\" : "\x07"}`;

function tracker(options: ResumeTrackerOptions = {}) {
  let now = T;
  const t = new ResumeTracker({ token: TOKEN, now: () => now, ...options });
  return {
    t,
    setNow(v: number) {
      now = v;
    },
  };
}

/** Minimal concrete BasePty with a controllable stats() snapshot. */
class TestPty extends BasePty {
  pids: number[] | null;
  constructor(pid: number, pids: number[] | null) {
    super(80, 24);
    this.pid = pid;
    this.pids = pids;
  }
  emit(data: string | Buffer): void {
    for (const l of this._dataListeners) l(data);
  }
  triggerExit(): void {
    this._handleExit({ exitCode: 0, signal: 0 });
  }
  get process(): string {
    return "test";
  }
  write(): void {}
  resize(): void {}
  clear(): void {}
  kill(): void {}
  pause(): void {}
  resume(): void {}
  close(): void {}
  stats(): IPtyStats | null {
    if (!this.pids) return null;
    const [leader, ...rest] = this.pids;
    return {
      pid: leader!,
      cwd: null,
      rssBytes: 0,
      cpuUser: 0,
      cpuSys: 0,
      count: this.pids.length,
      children: rest.map((pid) => ({ pid, name: "x", rssBytes: 0, cpuUser: 0, cpuSys: 0 })),
    };
  }
}

describe("createResumeToken", () => {
  it("produces distinct spec-conforming tokens", () => {
    const a = createResumeToken();
    const b = createResumeToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    expect(a).not.toBe(b);
  });
});

describe("verifyResumeReport", () => {
  it("accepts every valid spec vector", () => {
    for (const body of [NVIM, NVIM_CLEAR, LAZYGIT, WRAP]) {
      const v = verifyResumeReport(body, TOKEN, { now: T });
      expect(v.status, body).toBe("accepted");
    }
    const v = verifyResumeReport(WRAP, TOKEN, { now: T });
    expect(v.status === "accepted" && v.report.argv).toEqual(["resume-wrap", "ssh", "devbox"]);
  });

  it("accepts a report decoded via decodeOSC", () => {
    const d = decodeOSC({ code: 7577, payload: LAZYGIT });
    expect(d.kind).toBe("resume");
    const v = verifyResumeReport(d as ResumeReport, TOKEN, { now: T });
    expect(v).toMatchObject({
      status: "accepted",
      report: { argv: ["lazygit"], cwd: "/home/user/src/project" },
    });
  });

  it("ignores a wrong token", () => {
    expect(verifyResumeReport(NVIM, "another-token-of-22-chars", { now: T })).toMatchObject({
      status: "ignored",
      reason: "mac mismatch",
    });
  });

  it("applies the time window (default 60s) and monotonic time", () => {
    expect(verifyResumeReport(NVIM, TOKEN, { now: T + 60 }).status).toBe("accepted");
    expect(verifyResumeReport(NVIM, TOKEN, { now: T - 60 }).status).toBe("accepted");
    expect(verifyResumeReport(NVIM, TOKEN, { now: T + 61 }).status).toBe("ignored");
    expect(verifyResumeReport(NVIM, TOKEN, { now: T + 100, window: 120 }).status).toBe("accepted");
    expect(verifyResumeReport(NVIM, TOKEN, { now: T, lastTime: T }).status).toBe("accepted");
    expect(verifyResumeReport(NVIM, TOKEN, { now: T, lastTime: T + 1 }).status).toBe("ignored");
  });

  it("checks mac and time before the grammar", () => {
    // Malformed AND wrong mac → ignored, not rejected.
    const bad = `pid=74877:time=${T}:argv=Li9ydW4uc2g=:mac=${"0".repeat(64)}`;
    expect(verifyResumeReport(bad, TOKEN, { now: T }).status).toBe("ignored");
    // Malformed AND stale → ignored.
    expect(
      verifyResumeReport(sign(`pid=74877:time=${T}:argv=Li9ydW4uc2g=`), TOKEN, { now: T + 999 })
        .status,
    ).toBe("ignored");
    // Malformed but authentic + fresh → rejected with owner.
    expect(
      verifyResumeReport(sign(`pid=74877:time=${T}:argv=Li9ydW4uc2g=`), TOKEN, { now: T }),
    ).toMatchObject({ status: "rejected", pid: 74877 });
  });

  it("rejects without an owner when pid is unusable", () => {
    const v = verifyResumeReport(sign(`pid=99999999999999999999:time=${T}:argv=bnZpbQ==`), TOKEN, {
      now: T,
    });
    expect(v.status).toBe("rejected");
    expect(v).not.toHaveProperty("pid");
  });
});

describe("formatResumeReport", () => {
  it("reproduces the spec vectors byte-for-byte", () => {
    expect(formatResumeReport({ pid: 74877, time: T, argv: NVIM_RECORD.argv }, TOKEN)).toBe(
      osc(NVIM),
    );
    expect(formatResumeReport({ pid: 74877, time: T, clear: true }, TOKEN)).toBe(osc(NVIM_CLEAR));
    expect(
      formatResumeReport(
        { pid: 74877, time: T, argv: ["lazygit"], cwd: "/home/user/src/project" },
        TOKEN,
      ),
    ).toBe(osc(LAZYGIT));
    expect(
      formatResumeReport({ pid: 90412, time: T, argv: ["resume-wrap", "ssh", "devbox"] }, TOKEN),
    ).toBe(osc(WRAP));
  });

  it("round-trips through ResumeTracker", () => {
    const token = createResumeToken();
    const t = new ResumeTracker({ token, validatePid: false });
    t.feed(
      formatResumeReport(
        { pid: 4242, argv: ["/usr/bin/agent", "--resume", "id 1; $(rm -rf ~)", ""], cwd: "/tmp" },
        t.token,
      ),
    );
    expect(t.record).toMatchObject({
      pid: 4242,
      argv: ["/usr/bin/agent", "--resume", "id 1; $(rm -rf ~)", ""],
      cwd: "/tmp",
    });
    t.dispose();
  });

  it("throws for reports that cannot be sent", () => {
    const f =
      (input: Parameters<typeof formatResumeReport>[0], token = TOKEN) =>
      () =>
        formatResumeReport(input, token);
    expect(f({ pid: 1, argv: ["nvim"] }, "short")).toThrow(TypeError);
    expect(f({ pid: 1 })).toThrow(/argv/);
    expect(f({ pid: 1, argv: ["nvim"], clear: true })).toThrow(/exactly one/);
    expect(f({ pid: 1, clear: true, cwd: "/" })).toThrow(/cwd/);
    expect(f({ pid: 1, argv: ["./run.sh"] })).toThrow(/relative/);
    expect(f({ pid: 1, argv: ["-x"] })).toThrow(/starts with/);
    expect(f({ pid: 1, argv: [] })).toThrow(/empty program/);
    expect(f({ pid: 1, argv: ["nvim", "a\nb"] })).toThrow(/argv/);
    expect(f({ pid: 1, argv: ["nvim"], cwd: "project" })).toThrow(/absolute/);
    expect(f({ pid: 0, argv: ["nvim"] })).toThrow(/pid/);
    expect(f({ pid: 1.5, argv: ["nvim"] })).toThrow();
  });
});

describe("ResumeTracker", () => {
  it("exposes the token and env", () => {
    const t = new ResumeTracker();
    expect(t.token).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    expect(t.env).toEqual({ OSC7577_TOKEN: t.token });
    expect(new ResumeTracker().token).not.toBe(t.token);
    expect(() => new ResumeTracker({ token: "too-short" })).toThrow(TypeError);
    expect(() => new ResumeTracker({ token: "has spaces in it and is long" })).toThrow(TypeError);
  });

  it("tracks the spec's nvim report then removes it on clear=1", () => {
    const { t } = tracker();
    const changes: (ResumeRecord | undefined)[] = [];
    t.onChange((r) => changes.push(r));
    t.feed(osc(NVIM));
    expect(t.record).toEqual(NVIM_RECORD);
    expect(t.records).toEqual([NVIM_RECORD]);
    t.feed(osc(NVIM_CLEAR));
    expect(t.record).toBeUndefined();
    expect(t.records).toEqual([]);
    expect(changes).toEqual([NVIM_RECORD, undefined]);
  });

  it("records cwd (lazygit vector) and replaces the owner's record", () => {
    const { t } = tracker();
    t.feed(osc(NVIM));
    t.feed(osc(LAZYGIT));
    expect(t.records).toEqual([
      { pid: 74877, argv: ["lazygit"], cwd: "/home/user/src/project", time: T },
    ]);
  });

  it("supports BEL and ESC \\ terminators", () => {
    const { t } = tracker();
    t.feed(osc(NVIM, "bel"));
    expect(t.record).toEqual(NVIM_RECORD);
    t.feed(osc(NVIM_CLEAR, "st"));
    expect(t.record).toBeUndefined();
  });

  it("stitches reports split across chunks (including inside ST)", () => {
    const { t } = tracker();
    const bytes = Buffer.from(`noise${osc(NVIM)}more`);
    for (let i = 0; i < bytes.length; i += 7) t.feed(bytes.subarray(i, i + 7));
    expect(t.record).toEqual(NVIM_RECORD);

    const { t: t2 } = tracker();
    const s = osc(NVIM);
    t2.feed(s.slice(0, -1)); // up to the ESC of ST
    expect(t2.record).toBeUndefined();
    t2.feed(s.slice(-1));
    expect(t2.record).toEqual(NVIM_RECORD);
  });

  it("works through pty.attach()", () => {
    const { t } = tracker({ validatePid: false });
    const pty = new TestPty(1, null);
    pty.attach(t);
    pty.emit(osc(NVIM).slice(0, 20));
    pty.emit(osc(NVIM).slice(20));
    expect(t.record).toEqual(NVIM_RECORD);
  });

  it("keeps records after the PTY exits (detach)", () => {
    const { t } = tracker({ validatePid: false });
    const pty = new TestPty(1, null);
    pty.attach(t);
    pty.emit(osc(NVIM));
    pty.triggerExit();
    expect(t.record).toEqual(NVIM_RECORD);
  });

  describe("spec 'Invalid reports' table", () => {
    // Each row starts from an accepted nvim record for pid 74877, so an ignored
    // report leaves it in place and a rejected one removes it.
    const rows: [string, string, "ignored" | "rejected"][] = [
      ["mac does not match", `pid=74877:time=${T}:argv=bnZpbQ==:mac=${"0".repeat(64)}`, "ignored"],
      ["no mac", `pid=74877:time=${T}:argv=bnZpbQ==`, "ignored"],
      [
        "mac is not the last key",
        `mac=${sign(`pid=74877:time=${T}:argv=bnZpbQ==`).slice(-64)}:pid=74877:time=${T}:argv=bnZpbQ==`,
        "ignored",
      ],
      ["time too far from clock", sign("pid=74877:time=1000000000:argv=bnZpbQ=="), "ignored"],
      ["no time", sign("pid=74877:argv=bnZpbQ=="), "ignored"],
      ["relative program path", sign(`pid=74877:time=${T}:argv=Li9ydW4uc2g=`), "rejected"],
      ["both argv and clear", sign(`pid=74877:time=${T}:argv=bnZpbQ==:clear=1`), "rejected"],
      ["relative cwd", sign(`pid=74877:time=${T}:argv=bnZpbQ==:cwd=cHJvamVjdA==`), "rejected"],
      ["need of unknown key", sign(`pid=74877:time=${T}:argv=bnZpbQ==:need=later`), "rejected"],
    ];
    for (const [name, body, outcome] of rows) {
      it(`${outcome}: ${name}`, () => {
        const { t } = tracker();
        t.feed(osc(NVIM));
        const listener = vi.fn();
        t.onChange(listener);
        expect(verifyResumeReport(body, TOKEN, { now: T }).status).toBe(outcome);
        t.feed(osc(body));
        if (outcome === "ignored") {
          expect(t.record).toEqual(NVIM_RECORD);
          expect(listener).not.toHaveBeenCalled();
        } else {
          expect(t.record).toBeUndefined();
          expect(listener).toHaveBeenCalledWith(undefined, []);
        }
      });
    }
  });

  it("rejects other strict-grammar failures", () => {
    const bodies = [
      `pid=74877:time=${T}:argv=bnZpbQ==:argv=bnZpbQ==`, // repeated key
      `pid=74877:time=${T}:argv=bnZpbQ=`, // bad padding
      `pid=74877:time=${T}:argv=/w==`, // not UTF-8
      `pid=74877:time=${T}:argv=bnZpbQ==,YQpi`, // control char
      `pid=74877:time=${T}:argv=LXJt`, // starts with -
      `pid=74877:time=${T}:argv=`, // empty program
      `pid=74877:time=${T}`, // neither argv nor clear
      `pid=74877:time=${T}:argv=bnZpbQ==:x`, // malformed pair
    ];
    for (const body of bodies) {
      const { t } = tracker();
      t.feed(osc(NVIM));
      t.feed(osc(sign(body)));
      expect(t.record, body).toBeUndefined();
    }
  });

  it("ignores reserved `?`, unknown keys don't hurt, unusable pid removes nothing", () => {
    const { t } = tracker();
    t.feed(osc(NVIM));
    t.feed(osc("?"));
    expect(t.record).toEqual(NVIM_RECORD);
    t.feed(osc(sign(`pid=74877:time=${T}:argv=bGF6eWdpdA==:later=x`)));
    expect(t.record?.argv).toEqual(["lazygit"]);
    t.feed(osc(sign(`pid=99999999999999999999:time=${T}:argv=Li9ydW4uc2g=`)));
    expect(t.records).toHaveLength(1);
  });

  it("ignores a wrong token", () => {
    const { t } = tracker();
    t.feed(osc(sign(`pid=1:time=${T}:argv=bnZpbQ==`, "some-other-token-of-22c")));
    expect(t.record).toBeUndefined();
  });

  it("ignores expired reports", () => {
    const { t, setNow } = tracker();
    setNow(T + 61);
    t.feed(osc(NVIM));
    expect(t.record).toBeUndefined();
    setNow(T + 60);
    t.feed(osc(NVIM));
    expect(t.record).toEqual(NVIM_RECORD);
  });

  it("honours a custom window", () => {
    const { t, setNow } = tracker({ window: 5 });
    setNow(T + 6);
    t.feed(osc(NVIM));
    expect(t.record).toBeUndefined();
  });

  it("ignores replays older than the last accepted report for the pid", () => {
    const { t } = tracker();
    const older = sign(`pid=74877:time=${T - 10}:argv=b2xk`); // "old"
    t.feed(osc(NVIM));
    t.feed(osc(older));
    expect(t.record).toEqual(NVIM_RECORD);
    // Even after the record is cleared, an older report can't resurrect it.
    t.feed(osc(NVIM_CLEAR));
    t.feed(osc(older));
    expect(t.record).toBeUndefined();
    // Same time is fine (the spec's own argv + clear pair share a time).
    t.feed(osc(NVIM));
    expect(t.record).toEqual(NVIM_RECORD);
    // Other pids are tracked independently.
    t.feed(osc(sign(`pid=5:time=${T - 10}:argv=b2xk`)));
    expect(t.records.map((r) => r.pid)).toEqual([74877, 5]);
  });

  it("does not let an ignored or rejected report advance the replay clock", () => {
    const { t } = tracker();
    t.feed(osc(NVIM));
    t.feed(osc(sign(`pid=74877:time=${T + 5}:argv=Li9ydW4uc2g=`))); // rejected
    t.feed(osc(NVIM)); // time T is still >= last accepted (T)
    expect(t.record).toEqual(NVIM_RECORD);
  });

  it("tracks multiple owners; record prefers the PTY leader, else most recent", () => {
    const { t } = tracker({ validatePid: false });
    t.feed(osc(sign(`pid=10:time=${T}:argv=YQ==`))); // a
    t.feed(osc(sign(`pid=20:time=${T}:argv=Yg==`))); // b
    expect(t.record?.pid).toBe(20);
    t.feed(osc(sign(`pid=10:time=${T}:argv=Yw==`))); // c — 10 becomes most recent
    expect(t.records.map((r) => [r.pid, r.argv[0]])).toEqual([
      [20, "b"],
      [10, "c"],
    ]);
    expect(t.record?.pid).toBe(10);

    const pty = new TestPty(20, null);
    pty.attach(t);
    expect(t.record?.pid).toBe(20);
  });

  it("returns copies — mutating a record does not change tracker state", () => {
    const { t } = tracker();
    t.feed(osc(NVIM));
    t.record!.argv.push("x");
    t.records[0]!.argv.length = 0;
    expect(t.record).toEqual(NVIM_RECORD);
  });

  it("validates the owner pid against the attached PTY's process tree", () => {
    const { t } = tracker();
    const pty = new TestPty(100, [100, 74877]);
    pty.attach(t);
    t.feed(osc(NVIM));
    expect(t.record).toEqual(NVIM_RECORD);

    // Owner no longer in the tree → rejected → owner's record removed.
    pty.pids = [100];
    t.feed(osc(sign(`pid=74877:time=${T}:argv=bGF6eWdpdA==`)));
    expect(t.record).toBeUndefined();

    // A report for a pid outside the tree never creates a record.
    t.feed(osc(sign(`pid=555:time=${T}:argv=bnZpbQ==`)));
    expect(t.record).toBeUndefined();

    // stats() unavailable → validation skipped.
    pty.pids = null;
    t.feed(osc(NVIM));
    expect(t.record).toEqual(NVIM_RECORD);
  });

  it("skips pid validation when validatePid is false", () => {
    const { t } = tracker({ validatePid: false });
    new TestPty(100, [100]).attach(t);
    t.feed(osc(NVIM));
    expect(t.record).toEqual(NVIM_RECORD);
  });

  it("clear() drops every record and always notifies", () => {
    const { t } = tracker({ validatePid: false });
    const listener = vi.fn();
    t.onChange(listener);
    t.clear();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(undefined, []);
    t.feed(osc(NVIM));
    t.feed(osc(WRAP));
    expect(t.records).toHaveLength(2);
    t.clear();
    expect(t.records).toEqual([]);
    expect(listener).toHaveBeenLastCalledWith(undefined, []);
  });

  it("onChange returns an unsubscribe and swallows listener errors", () => {
    const { t } = tracker();
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    t.onChange(bad);
    const off = t.onChange(good);
    t.feed(osc(NVIM));
    expect(good).toHaveBeenCalledWith(NVIM_RECORD, [NVIM_RECORD]);
    off();
    t.feed(osc(NVIM_CLEAR));
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(2);
  });

  it("does not notify when a clear has nothing to remove", () => {
    const { t } = tracker();
    const listener = vi.fn();
    t.onChange(listener);
    t.feed(osc(NVIM_CLEAR));
    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose() drops records and stops parsing", () => {
    const { t } = tracker();
    const listener = vi.fn();
    t.onChange(listener);
    t.feed(osc(NVIM));
    t.dispose();
    expect(t.record).toBeUndefined();
    t.feed(osc(LAZYGIT));
    expect(t.record).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("accepts a report at the spec minimums (64 argv elements, 2048 bytes)", () => {
    const { t } = tracker();
    const argv = ["/usr/bin/prog"];
    while (argv.length < 64) argv.push("x".repeat(20));
    let seq = formatResumeReport({ pid: 74877, time: T, argv }, TOKEN);
    // Pad the last element until the whole sequence is >= 2048 bytes.
    while (Buffer.byteLength(seq) < 2048) {
      argv[63] += "y";
      seq = formatResumeReport({ pid: 74877, time: T, argv }, TOKEN);
    }
    expect(Buffer.byteLength(seq)).toBeGreaterThanOrEqual(2048);
    t.feed(seq);
    expect(t.record?.argv).toEqual(argv);
  });

  it("ignores a report too long for the parser (and keeps the old record)", () => {
    const { t } = tracker();
    t.feed(osc(NVIM));
    const huge = formatResumeReport(
      { pid: 74877, time: T, argv: ["big", "z".repeat(5000)] },
      TOKEN,
    );
    t.feed(huge);
    expect(t.record).toEqual(NVIM_RECORD);
  });
});
