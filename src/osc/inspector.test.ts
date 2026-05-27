import { Buffer } from "node:buffer";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  builtinOSCDecoders,
  createOSCDecoder,
  decodeOSC,
  OSCInspector,
  type DecodedOSC,
  type OSCEvent,
} from "./index.ts";

describe("OSCInspector", () => {
  it("parses a BEL-terminated title sequence", () => {
    const events: OSCEvent[] = [];
    const i = new OSCInspector((e) => events.push(e));
    i.feed("\x1b]0;hello\x07");
    expect(events).toEqual([{ code: 0, payload: "hello" }]);
    i.dispose();
  });

  it("parses an ST-terminated notification sequence", () => {
    const events: OSCEvent[] = [];
    const i = new OSCInspector((e) => events.push(e));
    i.feed("\x1b]9;4;1;42\x1b\\");
    expect(events).toEqual([{ code: 9, payload: "4;1;42" }]);
    i.dispose();
  });

  it("stitches sequences split across feed calls", () => {
    const events: OSCEvent[] = [];
    const i = new OSCInspector((e) => events.push(e));
    i.feed("\x1b]1337;Reque");
    expect(events).toHaveLength(0);
    i.feed("stAttention=fireworks\x07");
    expect(events).toEqual([{ code: 1337, payload: "RequestAttention=fireworks" }]);
    i.dispose();
  });

  it("emits multiple sequences from a single chunk", () => {
    const events: OSCEvent[] = [];
    const i = new OSCInspector((e) => events.push(e));
    i.feed("noise\x1b]133;A\x07inter\x1b]7;file:///tmp\x07tail");
    expect(events).toEqual([
      { code: 133, payload: "A" },
      { code: 7, payload: "file:///tmp" },
    ]);
    i.dispose();
  });

  it("accepts Buffer and Uint8Array input", () => {
    const events: OSCEvent[] = [];
    const i = new OSCInspector((e) => events.push(e));
    i.feed(Buffer.from("\x1b]2;buf\x07", "utf8"));
    i.feed(new Uint8Array(Buffer.from("\x1b]2;u8\x07", "utf8")));
    expect(events).toEqual([
      { code: 2, payload: "buf" },
      { code: 2, payload: "u8" },
    ]);
    i.dispose();
  });

  it("ignores non-OSC escape sequences", () => {
    const events: OSCEvent[] = [];
    const i = new OSCInspector((e) => events.push(e));
    i.feed("plain text \x1b[31mred\x1b[0m and \x1b]0;t\x07");
    expect(events).toEqual([{ code: 0, payload: "t" }]);
    i.dispose();
  });

  it("supports multiple listeners and unsubscribe", () => {
    const a: OSCEvent[] = [];
    const b: OSCEvent[] = [];
    const i = new OSCInspector();
    i.on((e) => a.push(e));
    const off = i.on((e) => b.push(e));
    i.feed("\x1b]0;one\x07");
    off();
    i.feed("\x1b]0;two\x07");
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    expect(b[0]).toEqual({ code: 0, payload: "one" });
    i.dispose();
  });

  it("does not throw when a listener throws", () => {
    const i = new OSCInspector(() => {
      throw new Error("boom");
    });
    expect(() => i.feed("\x1b]0;x\x07")).not.toThrow();
    i.dispose();
  });

  it("CAN (0x18) cancels an in-flight OSC sequence", () => {
    const events: OSCEvent[] = [];
    const i = new OSCInspector((e) => events.push(e));
    i.feed("\x1b]0;abort\x18\x1b]1;ok\x07");
    expect(events).toEqual([{ code: 1, payload: "ok" }]);
    i.dispose();
  });

  it("SUB (0x1a) cancels an in-flight OSC sequence", () => {
    const events: OSCEvent[] = [];
    const i = new OSCInspector((e) => events.push(e));
    i.feed("\x1b]0;abort\x1a\x1b]2;ok\x07");
    expect(events).toEqual([{ code: 2, payload: "ok" }]);
    i.dispose();
  });

  it("recovers when a stray ESC inside payload is followed by ESC ]", () => {
    const events: OSCEvent[] = [];
    const i = new OSCInspector((e) => events.push(e));
    // ESC ] 0 ; abort ESC <not-backslash-not-ESC> => abort; the next ESC ] starts a new OSC.
    i.feed("\x1b]0;abort\x1b\x1b]1;ok\x07");
    expect(events).toEqual([{ code: 1, payload: "ok" }]);
    i.dispose();
  });
});

describe("decodeOSC", () => {
  it("decodes window-title codes 0/1/2", () => {
    expect(decodeOSC({ code: 0, payload: "t" })).toMatchObject({ kind: "title", code: 0 });
    expect(decodeOSC({ code: 2, payload: "t" })).toMatchObject({ kind: "title", code: 2 });
  });

  it("decodes OSC 7 cwd uri", () => {
    const d = decodeOSC({ code: 7, payload: "file://host/var/log" });
    expect(d).toEqual({ kind: "cwd", uri: "file://host/var/log", host: "host", path: "/var/log" });
  });

  it("decodes OSC 133 shell integration", () => {
    expect(decodeOSC({ code: 133, payload: "D;0" })).toEqual({
      kind: "shellIntegration",
      vendor: "vt",
      command: "D",
      data: "0",
    });
  });

  it("decodes OSC 633 vscode integration", () => {
    expect(decodeOSC({ code: 633, payload: "E;echo hello" })).toEqual({
      kind: "shellIntegration",
      vendor: "vscode",
      command: "E",
      data: "echo hello",
    });
  });

  it("decodes OSC 9 progress (state;value)", () => {
    expect(decodeOSC({ code: 9, payload: "4;1;75" })).toEqual({
      kind: "progress",
      state: 1,
      value: 75,
    });
  });

  it("decodes OSC 9 ConEmu/Windows-Terminal notification", () => {
    expect(decodeOSC({ code: 9, payload: "9;Build done" })).toMatchObject({
      kind: "notification",
      vendor: "conemu",
      body: "Build done",
    });
  });

  it("decodes OSC 9 iterm-style notification", () => {
    expect(decodeOSC({ code: 9, payload: "Build done" })).toMatchObject({
      kind: "notification",
      vendor: "iterm",
      body: "Build done",
    });
  });

  it("decodes OSC 99 kitty notification fragments", () => {
    expect(decodeOSC({ code: 99, payload: "i=1:p=title;Build" })).toMatchObject({
      kind: "notification",
      vendor: "kitty",
      title: "Build",
    });
    expect(decodeOSC({ code: 99, payload: "i=1:p=body;ok" })).toMatchObject({
      kind: "notification",
      vendor: "kitty",
      body: "ok",
    });
    expect(decodeOSC({ code: 99, payload: "i=1:p=done" })).toMatchObject({
      kind: "notification",
      vendor: "kitty",
      done: true,
    });
  });

  it("decodes OSC 1337 RequestAttention variants and notify", () => {
    expect(decodeOSC({ code: 1337, payload: "RequestAttention" })).toMatchObject({
      kind: "attention",
      vendor: "iterm",
      action: "request",
      value: "yes",
    });
    expect(decodeOSC({ code: 1337, payload: "RequestAttention=yes" })).toMatchObject({
      kind: "attention",
      vendor: "iterm",
      action: "request",
      value: "yes",
    });
    expect(decodeOSC({ code: 1337, payload: "RequestAttention=no" })).toMatchObject({
      kind: "attention",
      vendor: "iterm",
      action: "cancel",
      value: "no",
    });
    expect(decodeOSC({ code: 1337, payload: "RequestAttention=fireworks" })).toMatchObject({
      kind: "attention",
      vendor: "iterm",
      action: "request",
      effect: "fireworks",
      value: "fireworks",
    });
    expect(decodeOSC({ code: 1337, payload: "RequestAttentionFoo=yes" })).toEqual({
      kind: "unknown",
      code: 1337,
      payload: "RequestAttentionFoo=yes",
    });
    expect(decodeOSC({ code: 1337, payload: "notify;title=Build;body=ok" })).toMatchObject({
      kind: "notification",
      vendor: "iterm",
      title: "Build",
      body: "ok",
    });
  });

  it("decodes OSC 777 urgency variants and notify", () => {
    expect(decodeOSC({ code: 777, payload: "urgency" })).toMatchObject({
      kind: "attention",
      vendor: "rxvt",
      action: "push",
    });
    expect(decodeOSC({ code: 777, payload: "urgency;push" })).toMatchObject({
      kind: "attention",
      vendor: "rxvt",
      action: "push",
    });
    expect(decodeOSC({ code: 777, payload: "urgency;pop" })).toMatchObject({
      kind: "attention",
      vendor: "rxvt",
      action: "pop",
    });
    expect(decodeOSC({ code: 777, payload: "notify;Build;ok" })).toMatchObject({
      kind: "notification",
      vendor: "rxvt",
      title: "Build",
      body: "ok",
    });
  });

  it("decodes OSC 8 hyperlink with id param", () => {
    expect(decodeOSC({ code: 8, payload: "id=42:foo=bar;https://example.com" })).toEqual({
      kind: "hyperlink",
      uri: "https://example.com",
      id: "42",
      params: { id: "42", foo: "bar" },
    });
  });

  it("decodes OSC 8 hyperlink close (empty uri)", () => {
    expect(decodeOSC({ code: 8, payload: ";" })).toEqual({
      kind: "hyperlink",
      uri: "",
      params: {},
    });
  });

  it("decodes OSC 52 clipboard set and query", () => {
    expect(decodeOSC({ code: 52, payload: "c;aGVsbG8=" })).toEqual({
      kind: "clipboard",
      selection: "c",
      data: "aGVsbG8=",
    });
    expect(decodeOSC({ code: 52, payload: "p;?" })).toEqual({
      kind: "clipboard",
      selection: "p",
      query: true,
    });
  });

  it("returns unknown for unrecognized codes", () => {
    expect(decodeOSC({ code: 4242, payload: "x" })).toEqual({
      kind: "unknown",
      code: 4242,
      payload: "x",
    });
  });
});

describe("createOSCDecoder", () => {
  it("falls back to built-ins when no customs provided", () => {
    const decode = createOSCDecoder();
    expect(decode({ code: 0, payload: "t" })).toMatchObject({ kind: "title", code: 0 });
    expect(decode({ code: 4242, payload: "x" })).toEqual({
      kind: "unknown",
      code: 4242,
      payload: "x",
    });
  });

  it("dispatches custom decoders for arbitrary codes (including unknown)", () => {
    const decode = createOSCDecoder({
      50: (p) => ({ kind: "screen-mode" as const, mode: p }),
      9999: (p, e) => ({ kind: "vendorX" as const, code: e.code, raw: p }),
    });

    expect(decode({ code: 50, payload: "fullscreen" })).toEqual({
      kind: "screen-mode",
      mode: "fullscreen",
    });
    expect(decode({ code: 9999, payload: "abc" })).toEqual({
      kind: "vendorX",
      code: 9999,
      raw: "abc",
    });
  });

  it("custom decoders override built-ins", () => {
    const decode = createOSCDecoder({
      133: (p) => ({ kind: "my-shell" as const, raw: p }),
    });
    expect(decode({ code: 133, payload: "A" })).toEqual({ kind: "my-shell", raw: "A" });
    // Other codes still hit built-ins
    expect(decode({ code: 0, payload: "t" })).toMatchObject({ kind: "title" });
  });

  it("custom decoders compose with built-in fallback for un-handled codes", () => {
    const decode = createOSCDecoder({
      50: (p) => ({ kind: "screen-mode" as const, mode: p }),
    });
    expect(decode({ code: 7, payload: "file:///tmp" })).toMatchObject({ kind: "cwd" });
    expect(decode({ code: 4242, payload: "x" })).toEqual({
      kind: "unknown",
      code: 4242,
      payload: "x",
    });
  });

  it("typed result is DecodedOSC | T", () => {
    const decode = createOSCDecoder({
      50: (p) => ({ kind: "screen-mode" as const, mode: p }),
    });
    const result = decode({ code: 50, payload: "x" });
    expectTypeOf(result).toEqualTypeOf<DecodedOSC | { kind: "screen-mode"; mode: string }>();
  });
});

describe("builtinOSCDecoders", () => {
  it("exposes every well-known code", () => {
    const codes = Object.keys(builtinOSCDecoders)
      .map(Number)
      .sort((a, b) => a - b);
    expect(codes).toEqual([0, 1, 2, 7, 8, 9, 52, 99, 133, 633, 777, 1337]);
  });

  it("individual decoders are callable for reuse", () => {
    const titleDecoder = builtinOSCDecoders[0]!;
    expect(titleDecoder("hi", { code: 0, payload: "hi" })).toEqual({
      kind: "title",
      code: 0,
      title: "hi",
    });
  });
});
