import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleDetector, type IdleEvent } from "./index.ts";

describe("IdleDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires active then idle after a sustained burst", async () => {
    const events: IdleEvent[] = [];
    const det = new IdleDetector((e) => events.push(e), {
      graceMs: 0,
      activeThreshold: 32,
      quietMs: 500,
    });
    det.feed("hello world ".repeat(8)); // 96 bytes
    expect(events.map((e) => e.type)).toEqual(["active"]);
    await vi.advanceTimersByTimeAsync(600);
    expect(events.map((e) => e.type)).toEqual(["active", "idle"]);
    det.dispose();
  });

  it("absorbs startup bytes during the grace period", async () => {
    const events: IdleEvent[] = [];
    const det = new IdleDetector((e) => events.push(e), {
      graceMs: 1000,
      activeThreshold: 16,
      quietMs: 500,
    });
    // Big initial banner during grace — should NOT fire active.
    det.feed("x".repeat(1024));
    await vi.advanceTimersByTimeAsync(600);
    expect(events).toEqual([]);

    // Wait past grace, then send another burst — that one should fire.
    await vi.advanceTimersByTimeAsync(600);
    det.feed("y".repeat(64));
    expect(events.map((e) => e.type)).toEqual(["active"]);
    det.dispose();
  });

  it("ignores small UI updates below the threshold", async () => {
    const events: IdleEvent[] = [];
    const det = new IdleDetector((e) => events.push(e), {
      graceMs: 0,
      activeThreshold: 256,
      quietMs: 500,
    });
    // Status-bar style: 20 bytes every second, well under threshold and
    // gaps > quietMs so the burst window resets each time.
    for (let i = 0; i < 10; i++) {
      det.feed("status update ");
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(events).toEqual([]);
    det.dispose();
  });

  it("does not count ANSI/CSI escapes toward the threshold", async () => {
    const events: IdleEvent[] = [];
    const det = new IdleDetector((e) => events.push(e), {
      graceMs: 0,
      activeThreshold: 100,
      quietMs: 500,
    });
    // ~150 bytes of CSI noise with only ~10 bytes of real text — too few
    // significant bytes to cross the threshold.
    const noise = "\x1b[2K\x1b[1G\x1b[31m\x1b[0m".repeat(10) + "spinner...";
    det.feed(noise);
    await vi.advanceTimersByTimeAsync(600);
    expect(events).toEqual([]);
    det.dispose();
  });

  it("handles ANSI sequences split across feed calls", async () => {
    const events: IdleEvent[] = [];
    const det = new IdleDetector((e) => events.push(e), {
      graceMs: 0,
      activeThreshold: 1,
      quietMs: 500,
    });
    // ESC [ split from the terminator — second half should still be
    // recognised as part of the CSI, contributing zero significant bytes.
    det.feed("\x1b[");
    det.feed("31m");
    // Now a single real character — that one byte should trigger active.
    det.feed("X");
    expect(events.map((e) => e.type)).toEqual(["active"]);
    det.dispose();
  });

  it("does not count OSC payload after stray ESC recovery", async () => {
    const events: IdleEvent[] = [];
    const det = new IdleDetector((e) => events.push(e), {
      graceMs: 0,
      activeThreshold: 4,
      quietMs: 500,
    });
    // A stray ESC inside one OSC followed by ESC ] starts another OSC. The
    // second OSC payload is still non-visible and should not count as text.
    det.feed("\x1b]0;abort\x1b\x1b]1;not visible\x07");
    await vi.advanceTimersByTimeAsync(600);
    expect(events).toEqual([]);
    det.dispose();
  });

  it("resets the idle timer while bytes keep flowing", async () => {
    const events: IdleEvent[] = [];
    const det = new IdleDetector((e) => events.push(e), {
      graceMs: 0,
      activeThreshold: 16,
      quietMs: 500,
    });
    det.feed("abcdefghijklmnop"); // → active
    expect(events).toHaveLength(1);

    // Keep feeding every 200ms — under quietMs each time, so idle never fires.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(200);
      det.feed("more");
    }
    expect(events.map((e) => e.type)).toEqual(["active"]);

    // Stop feeding — idle fires after quietMs.
    await vi.advanceTimersByTimeAsync(600);
    expect(events.map((e) => e.type)).toEqual(["active", "idle"]);
    det.dispose();
  });

  it("reports significant byte count and duration on transitions", async () => {
    const events: IdleEvent[] = [];
    const det = new IdleDetector((e) => events.push(e), {
      graceMs: 0,
      activeThreshold: 10,
      quietMs: 500,
    });
    det.feed("hello world!"); // 12 bytes — fires active
    await vi.advanceTimersByTimeAsync(600);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("active");
    expect(events[0]!.bytes).toBe(12);
    expect(events[1]!.type).toBe("idle");
    expect(events[1]!.bytes).toBe(12);
    expect(events[1]!.durationMs).toBeGreaterThanOrEqual(500);
    det.dispose();
  });

  it("supports multiple listeners and unsubscribe", async () => {
    const a: IdleEvent[] = [];
    const b: IdleEvent[] = [];
    const det = new IdleDetector(undefined, {
      graceMs: 0,
      activeThreshold: 4,
      quietMs: 500,
    });
    det.on((e) => a.push(e));
    const off = det.on((e) => b.push(e));
    det.feed("xxxx");
    off();
    await vi.advanceTimersByTimeAsync(600);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    expect(b[0]!.type).toBe("active");
    det.dispose();
  });

  it("swallows listener errors so detection keeps working", async () => {
    const det = new IdleDetector(
      () => {
        throw new Error("boom");
      },
      { graceMs: 0, activeThreshold: 4, quietMs: 500 },
    );
    expect(() => det.feed("xxxx")).not.toThrow();
    await expect(vi.advanceTimersByTimeAsync(600)).resolves.not.toThrow();
    det.dispose();
  });

  it("accepts Buffer and Uint8Array input", async () => {
    const events: IdleEvent[] = [];
    const det = new IdleDetector((e) => events.push(e), {
      graceMs: 0,
      activeThreshold: 4,
      quietMs: 500,
    });
    det.feed(Buffer.from("aaaa", "utf8"));
    det.feed(new Uint8Array(Buffer.from("bbbb", "utf8")));
    expect(events.map((e) => e.type)).toEqual(["active"]);
    det.dispose();
  });

  it("dispose() cancels the pending idle timer", async () => {
    const events: IdleEvent[] = [];
    const det = new IdleDetector((e) => events.push(e), {
      graceMs: 0,
      activeThreshold: 4,
      quietMs: 500,
    });
    det.feed("xxxx");
    expect(events).toHaveLength(1);
    det.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    // No idle event after dispose.
    expect(events).toHaveLength(1);
  });

  it("suppress() absorbs the redraw burst without firing active", async () => {
    const events: IdleEvent[] = [];
    const det = new IdleDetector((e) => events.push(e), {
      graceMs: 0,
      activeThreshold: 16,
      quietMs: 500,
      redrawGraceMs: 300,
    });
    // A full-screen repaint right after an explicit redraw — suppressed.
    det.suppress();
    det.feed("x".repeat(1024));
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toEqual([]);

    // Past the suppression window, real output counts again.
    await vi.advanceTimersByTimeAsync(200);
    det.feed("y".repeat(64));
    expect(events.map((e) => e.type)).toEqual(["active"]);
    det.dispose();
  });

  it("onResize suppresses the repaint that follows a resize", async () => {
    const events: IdleEvent[] = [];
    const det = new IdleDetector((e) => events.push(e), {
      graceMs: 0,
      activeThreshold: 16,
      quietMs: 500,
      redrawGraceMs: 300,
    });
    det.onResize(120, 40);
    det.feed("repaint ".repeat(128)); // big burst — absorbed
    await vi.advanceTimersByTimeAsync(400);
    expect(events).toEqual([]);
    det.dispose();
  });

  it("suppress() does not keep an active burst alive past quietMs", async () => {
    const events: IdleEvent[] = [];
    const det = new IdleDetector((e) => events.push(e), {
      graceMs: 0,
      activeThreshold: 16,
      quietMs: 500,
      redrawGraceMs: 1000,
    });
    det.feed("abcdefghijklmnop"); // → active
    expect(events.map((e) => e.type)).toEqual(["active"]);

    // Resize mid-stream: the repaint must not reschedule idle.
    det.onResize(80, 24);
    await vi.advanceTimersByTimeAsync(200);
    det.feed("x".repeat(256));
    await vi.advanceTimersByTimeAsync(600);
    expect(events.map((e) => e.type)).toEqual(["active", "idle"]);
    det.dispose();
  });

  it("onAttach resets the grace window from the attach time", async () => {
    const events: IdleEvent[] = [];
    const det = new IdleDetector((e) => events.push(e), {
      graceMs: 500,
      activeThreshold: 4,
      quietMs: 500,
    });
    // 1s passes between construction and attach.
    await vi.advanceTimersByTimeAsync(1000);
    det.onAttach({} as never);
    // Burst arrives ~immediately after attach — still inside grace.
    det.feed("xxxx");
    expect(events).toEqual([]);
    // Past grace — same burst now counts.
    await vi.advanceTimersByTimeAsync(600);
    det.feed("yyyy");
    expect(events.map((e) => e.type)).toEqual(["active"]);
    det.dispose();
  });
});
