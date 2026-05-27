import { describe, expect, it, vi } from "vitest";
import { BasePty } from "./pty/_base.ts";
import { OSCInspector } from "./osc/index.ts";
import type { IPty, IPtyConsumer, IPtyStats } from "./pty/types.ts";

/** Minimal concrete BasePty used to drive attach() in isolation. */
class TestPty extends BasePty {
  constructor() {
    super(80, 24);
    this.pid = 1;
  }
  emit(data: string | Buffer): void {
    for (const l of this._dataListeners) l(data);
  }
  triggerExit(info = { exitCode: 0, signal: 0 }): void {
    this._handleExit(info);
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
    return null;
  }
}

describe("BasePty.attach", () => {
  it("forwards data chunks to the consumer's feed()", () => {
    const pty = new TestPty();
    const feed = vi.fn();
    pty.attach({ feed });

    pty.emit("hello");
    pty.emit(Buffer.from(" world"));

    expect(feed).toHaveBeenCalledTimes(2);
    expect(feed).toHaveBeenNthCalledWith(1, "hello");
    expect(feed).toHaveBeenNthCalledWith(2, Buffer.from(" world"));
  });

  it("calls onAttach with the pty before any feed", () => {
    const pty = new TestPty();
    const calls: string[] = [];
    const consumer: IPtyConsumer = {
      feed: () => calls.push("feed"),
      onAttach: (p) => {
        calls.push("attach");
        expect(p).toBe(pty);
      },
    };
    pty.attach(consumer);
    pty.emit("x");
    expect(calls).toEqual(["attach", "feed"]);
  });

  it("dispose() detaches and calls onDetach", () => {
    const pty = new TestPty();
    const feed = vi.fn();
    const onDetach = vi.fn();
    const disp = pty.attach({ feed, onDetach });

    pty.emit("a");
    disp.dispose();
    pty.emit("b");

    expect(feed).toHaveBeenCalledTimes(1);
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(onDetach).toHaveBeenCalledWith(pty);
  });

  it("dispose() is idempotent — onDetach fires only once", () => {
    const pty = new TestPty();
    const onDetach = vi.fn();
    const disp = pty.attach({ feed: () => {}, onDetach });

    disp.dispose();
    disp.dispose();
    disp.dispose();
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  it("auto-detaches when the PTY exits — onDetach fires once, no more feed", () => {
    const pty = new TestPty();
    const feed = vi.fn();
    const onDetach = vi.fn();
    pty.attach({ feed, onDetach });

    pty.emit("before");
    pty.triggerExit({ exitCode: 0, signal: 0 });
    pty.emit("after"); // exit clears _dataListeners; no-op

    expect(feed).toHaveBeenCalledTimes(1);
    expect(feed).toHaveBeenCalledWith("before");
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  it("explicit dispose after auto-detach does not double-fire onDetach", () => {
    const pty = new TestPty();
    const onDetach = vi.fn();
    const disp = pty.attach({ feed: () => {}, onDetach });
    pty.triggerExit();
    disp.dispose();
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  it("supports multiple consumers independently", () => {
    const pty = new TestPty();
    const a = vi.fn();
    const b = vi.fn();
    const dispA = pty.attach({ feed: a });
    pty.attach({ feed: b });

    pty.emit("x");
    dispA.dispose();
    pty.emit("y");

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("swallows errors thrown by feed() so the data path stays healthy", () => {
    const pty = new TestPty();
    const good = vi.fn();
    pty.attach({
      feed: () => {
        throw new Error("boom");
      },
    });
    pty.attach({ feed: good });

    expect(() => pty.emit("x")).not.toThrow();
    expect(good).toHaveBeenCalledWith("x");
  });

  it("OSCInspector conforms to IPtyConsumer and parses attached output", () => {
    const pty = new TestPty();
    const events: number[] = [];
    const inspector = new OSCInspector((e) => events.push(e.code));

    // Compile-time check: OSCInspector is assignable to IPtyConsumer
    const _typecheck: IPtyConsumer = inspector;
    void _typecheck;

    pty.attach(inspector);
    pty.emit("\x1b]0;title\x07\x1b]133;A\x07");
    expect(events).toEqual([0, 133]);

    // Auto-detach on exit; subsequent emits do nothing.
    pty.triggerExit();
    pty.emit("\x1b]9;x\x07");
    expect(events).toEqual([0, 133]);
  });

  it("attach() returns IDisposable from IPty interface", () => {
    const pty: IPty = new TestPty();
    const disp = pty.attach({ feed: () => {} });
    expect(typeof disp.dispose).toBe("function");
    disp.dispose();
  });
});
