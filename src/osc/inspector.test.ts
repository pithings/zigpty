import { Buffer } from "node:buffer";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  builtinOSCDecoders,
  createOSCDecoder,
  decodeOSC,
  OSCInspector,
  type DecodedOSC,
  type OSCEvent,
  type OSCState,
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

describe("OSCInspector.state", () => {
  it("tracks title (OSC 2) and icon (OSC 1) separately, OSC 0 sets both", () => {
    const i = new OSCInspector();
    i.feed("\x1b]2;window\x07");
    expect(i.state).toEqual({ title: "window" });
    i.feed("\x1b]1;icon\x07");
    expect(i.state).toEqual({ title: "window", iconName: "icon" });
    i.feed("\x1b]0;both\x07");
    expect(i.state).toEqual({ title: "both", iconName: "both" });
    i.dispose();
  });

  it("tracks cwd from OSC 7, OSC 1337 CurrentDir, and OSC 9;9", () => {
    const i = new OSCInspector();
    i.feed("\x1b]7;file://host/var/log\x07");
    expect(i.state.cwd).toEqual({ path: "/var/log", source: "osc7", host: "host" });
    i.feed("\x1b]1337;CurrentDir=/home/foo\x07");
    expect(i.state.cwd).toEqual({ path: "/home/foo", source: "iterm" });
    i.feed("\x1b]9;9;C:\\Users\\dev\x07");
    expect(i.state.cwd).toEqual({ path: "C:\\Users\\dev", source: "conemu" });
    i.dispose();
  });

  it("tracks active hyperlink between open and close", () => {
    const i = new OSCInspector();
    i.feed("\x1b]8;id=42;https://example.com\x07");
    expect(i.state.hyperlink).toEqual({
      uri: "https://example.com",
      id: "42",
      params: { id: "42" },
    });
    i.feed("\x1b]8;;\x07");
    expect(i.state.hyperlink).toBeUndefined();
    i.dispose();
  });

  it("tracks progress and clears on state 0", () => {
    const i = new OSCInspector();
    i.feed("\x1b]9;4;1;75\x07");
    expect(i.state.progress).toEqual({ state: 1, value: 75 });
    i.feed("\x1b]9;4;3\x07");
    expect(i.state.progress).toEqual({ state: 3 });
    i.feed("\x1b]9;4;0\x07");
    expect(i.state.progress).toBeUndefined();
    i.dispose();
  });

  it("tracks remoteHost, shellIntegrationVersion, and userVars", () => {
    const i = new OSCInspector();
    i.feed("\x1b]1337;RemoteHost=alice@example.com\x07");
    expect(i.state.remoteHost).toEqual({ user: "alice", host: "example.com" });
    i.feed("\x1b]1337;ShellIntegrationVersion=5\x07");
    expect(i.state.shellIntegrationVersion).toEqual("5");
    const base64 = Buffer.from("hello", "utf8").toString("base64");
    i.feed(`\x1b]1337;SetUserVar=greeting=${base64}\x07`);
    i.feed(`\x1b]1337;SetUserVar=other=${Buffer.from("world", "utf8").toString("base64")}\x07`);
    expect(i.state.userVars).toEqual({ greeting: "hello", other: "world" });
    i.dispose();
  });

  it("does not touch state for non-state sequences (notifications, marks, clipboard)", () => {
    const i = new OSCInspector();
    i.feed("\x1b]9;Build done\x07");
    i.feed("\x1b]1337;SetMark\x07");
    i.feed("\x1b]52;c;aGVsbG8=\x07");
    expect(i.state).toEqual({});
    i.dispose();
  });

  it("notifies state listeners only when state mutates", () => {
    const i = new OSCInspector();
    const snapshots: OSCState[] = [];
    i.onStateChange((s) => snapshots.push({ ...s }));
    i.feed("\x1b]0;t1\x07");
    i.feed("\x1b]9;Build done\x07"); // notification — no state change
    i.feed("\x1b]2;t2\x07");
    expect(snapshots).toEqual([
      { title: "t1", iconName: "t1" },
      { title: "t2", iconName: "t1" },
    ]);
    i.dispose();
  });

  it("state listeners can read fresh state synchronously", () => {
    const i = new OSCInspector();
    let observed: string | undefined;
    i.onStateChange((s) => {
      observed = s.title;
    });
    i.feed("\x1b]2;hello\x07");
    expect(observed).toEqual("hello");
    i.dispose();
  });

  it("dispose clears state", () => {
    const i = new OSCInspector();
    i.feed("\x1b]2;t\x07");
    i.feed("\x1b]7;file:///tmp\x07");
    expect(i.state.title).toEqual("t");
    expect(i.state.cwd?.path).toEqual("/tmp");
    i.dispose();
    expect(i.state).toEqual({});
  });

  it("onStateChange returns a working disposer", () => {
    const i = new OSCInspector();
    let n = 0;
    const off = i.onStateChange(() => {
      n++;
    });
    i.feed("\x1b]2;a\x07");
    off();
    i.feed("\x1b]2;b\x07");
    expect(n).toEqual(1);
    i.dispose();
  });
});

describe("decodeOSC", () => {
  it("decodes window-title codes 0/1/2", () => {
    expect(decodeOSC({ code: 0, payload: "t" })).toMatchObject({ kind: "title", code: 0 });
    expect(decodeOSC({ code: 2, payload: "t" })).toMatchObject({ kind: "title", code: 2 });
  });

  it("strips embedded C0 control bytes from titles", () => {
    expect(decodeOSC({ code: 2, payload: "hi\x05there\x01" })).toEqual({
      kind: "title",
      code: 2,
      title: "hithere",
    });
  });

  it("decodes OSC 7 cwd uri with percent-decoded path", () => {
    expect(decodeOSC({ code: 7, payload: "file://host/var/log" })).toEqual({
      kind: "cwd",
      source: "osc7",
      uri: "file://host/var/log",
      scheme: "file",
      host: "host",
      path: "/var/log",
      local: false,
    });
    expect(decodeOSC({ code: 7, payload: "file://localhost/tmp/with%20space" })).toEqual({
      kind: "cwd",
      source: "osc7",
      uri: "file://localhost/tmp/with%20space",
      scheme: "file",
      host: "localhost",
      path: "/tmp/with space",
      local: true,
    });
    expect(decodeOSC({ code: 7, payload: "file:///etc" })).toMatchObject({
      kind: "cwd",
      source: "osc7",
      host: undefined,
      path: "/etc",
      local: true,
    });
  });

  it("falls back to raw path when OSC 7 percent-decoding fails", () => {
    expect(decodeOSC({ code: 7, payload: "file:///bad%ZZ" })).toMatchObject({
      kind: "cwd",
      source: "osc7",
      path: "/bad%ZZ",
    });
  });

  it("decodes OSC 133 shell integration commands", () => {
    expect(decodeOSC({ code: 133, payload: "A" })).toEqual({
      kind: "shellIntegration",
      vendor: "vt",
      command: "A",
      data: "",
    });
    expect(decodeOSC({ code: 133, payload: "D;0" })).toMatchObject({
      kind: "shellIntegration",
      vendor: "vt",
      command: "D",
      data: "0",
      exitCode: 0,
    });
    expect(decodeOSC({ code: 133, payload: "D;127;err=" })).toMatchObject({
      kind: "shellIntegration",
      command: "D",
      exitCode: 127,
      err: "",
    });
    expect(decodeOSC({ code: 133, payload: "A;redraw=0;special_key=1" })).toMatchObject({
      kind: "shellIntegration",
      command: "A",
      params: { redraw: "0", special_key: "1" },
    });
  });

  it("decodes OSC 633 vscode integration", () => {
    expect(decodeOSC({ code: 633, payload: "E;echo hello" })).toMatchObject({
      kind: "shellIntegration",
      vendor: "vscode",
      command: "E",
      commandLine: "echo hello",
    });
    expect(decodeOSC({ code: 633, payload: "E;echo hi\\x3bworld;nonce123" })).toMatchObject({
      kind: "shellIntegration",
      command: "E",
      commandLine: "echo hi;world",
      nonce: "nonce123",
    });
    expect(decodeOSC({ code: 633, payload: "P;Cwd=/home/foo" })).toMatchObject({
      kind: "shellIntegration",
      command: "P",
      key: "Cwd",
      value: "/home/foo",
    });
    expect(decodeOSC({ code: 633, payload: "D;0" })).toMatchObject({
      kind: "shellIntegration",
      command: "D",
      exitCode: 0,
    });
    expect(
      decodeOSC({ code: 633, payload: "EnvSingleEntry;PATH;/usr/bin\\x3a/bin;abc" }),
    ).toMatchObject({
      kind: "shellIntegration",
      command: "EnvSingleEntry",
      key: "PATH",
      value: "/usr/bin:/bin",
      nonce: "abc",
    });
    expect(decodeOSC({ code: 633, payload: "EnvSingleStart;0;abc" })).toMatchObject({
      kind: "shellIntegration",
      command: "EnvSingleStart",
      index: 0,
      nonce: "abc",
    });
    expect(decodeOSC({ code: 633, payload: "EnvSingleEnd;abc" })).toMatchObject({
      kind: "shellIntegration",
      command: "EnvSingleEnd",
      nonce: "abc",
    });
  });

  it("decodes OSC 9 progress (state;value) and omits value for state 0/3", () => {
    expect(decodeOSC({ code: 9, payload: "4;1;75" })).toEqual({
      kind: "progress",
      state: 1,
      value: 75,
    });
    expect(decodeOSC({ code: 9, payload: "4;0" })).toEqual({ kind: "progress", state: 0 });
    expect(decodeOSC({ code: 9, payload: "4;3" })).toEqual({ kind: "progress", state: 3 });
  });

  it("decodes OSC 9;9 as ConEmu/Windows-Terminal CWD (not a notification)", () => {
    expect(decodeOSC({ code: 9, payload: "9;C:\\Users\\dev" })).toEqual({
      kind: "cwd",
      source: "conemu",
      path: "C:\\Users\\dev",
    });
    // ConEmu sometimes quotes the path
    expect(decodeOSC({ code: 9, payload: '9;"C:\\Users\\dev"' })).toEqual({
      kind: "cwd",
      source: "conemu",
      path: "C:\\Users\\dev",
    });
  });

  it("decodes OSC 9;12 as ConEmu prompt mark", () => {
    expect(decodeOSC({ code: 9, payload: "12" })).toEqual({
      kind: "mark",
      vendor: "conemu",
      raw: "12",
    });
  });

  it("classifies unknown ConEmu sub-commands as unknown, not iTerm notifications", () => {
    expect(decodeOSC({ code: 9, payload: "3;tab title" })).toEqual({
      kind: "unknown",
      code: 9,
      payload: "3;tab title",
    });
    expect(decodeOSC({ code: 9, payload: "11;hi" })).toEqual({
      kind: "unknown",
      code: 9,
      payload: "11;hi",
    });
  });

  it("decodes OSC 9 with non-digit head as iTerm notification", () => {
    expect(decodeOSC({ code: 9, payload: "Build done" })).toMatchObject({
      kind: "notification",
      vendor: "iterm",
      body: "Build done",
    });
  });

  it("decodes OSC 99 kitty notification chunks", () => {
    expect(decodeOSC({ code: 99, payload: "i=abc:p=title;Build" })).toMatchObject({
      kind: "notification",
      vendor: "kitty",
      id: "abc",
      title: "Build",
    });
    expect(decodeOSC({ code: 99, payload: "i=abc:p=body;ok" })).toMatchObject({
      kind: "notification",
      vendor: "kitty",
      id: "abc",
      body: "ok",
    });
    // d=0 means more chunks pending
    expect(decodeOSC({ code: 99, payload: "i=abc:d=0:p=body;part" })).toMatchObject({
      kind: "notification",
      vendor: "kitty",
      partial: true,
    });
    // urgency
    expect(decodeOSC({ code: 99, payload: "i=abc:u=2;Critical" })).toMatchObject({
      kind: "notification",
      vendor: "kitty",
      urgency: 2,
      title: "Critical",
    });
    // base64-encoded payload (e=1)
    const base64 = Buffer.from("héllo", "utf8").toString("base64");
    expect(decodeOSC({ code: 99, payload: `i=x:e=1:p=title;${base64}` })).toMatchObject({
      kind: "notification",
      title: "héllo",
    });
    // close phase (non-payload-bearing)
    expect(decodeOSC({ code: 99, payload: "i=x:p=close" })).toMatchObject({
      kind: "notification",
      vendor: "kitty",
      phase: "close",
    });
  });

  it("decodes OSC 1337 RequestAttention variants", () => {
    expect(decodeOSC({ code: 1337, payload: "RequestAttention" })).toMatchObject({
      kind: "attention",
      vendor: "iterm",
      action: "request",
      value: "yes",
    });
    expect(decodeOSC({ code: 1337, payload: "RequestAttention=yes" })).toMatchObject({
      kind: "attention",
      action: "request",
      value: "yes",
    });
    expect(decodeOSC({ code: 1337, payload: "RequestAttention=no" })).toMatchObject({
      kind: "attention",
      action: "cancel",
      value: "no",
    });
    expect(decodeOSC({ code: 1337, payload: "RequestAttention=fireworks" })).toMatchObject({
      kind: "attention",
      action: "request",
      effect: "fireworks",
      value: "fireworks",
    });
    expect(decodeOSC({ code: 1337, payload: "RequestAttention=once" })).toMatchObject({
      kind: "attention",
      action: "request",
      effect: "once",
      value: "once",
    });
    expect(decodeOSC({ code: 1337, payload: "RequestAttentionFoo=yes" })).toEqual({
      kind: "unknown",
      code: 1337,
      payload: "RequestAttentionFoo=yes",
    });
  });

  it("decodes OSC 1337 CurrentDir / SetMark / RemoteHost / SetUserVar / Copy / ShellIntegrationVersion", () => {
    expect(decodeOSC({ code: 1337, payload: "CurrentDir=/home/foo" })).toEqual({
      kind: "cwd",
      source: "iterm",
      path: "/home/foo",
    });
    expect(decodeOSC({ code: 1337, payload: "SetMark" })).toEqual({
      kind: "mark",
      vendor: "iterm",
      raw: "SetMark",
    });
    expect(decodeOSC({ code: 1337, payload: "RemoteHost=alice@example.com" })).toEqual({
      kind: "remoteHost",
      vendor: "iterm",
      user: "alice",
      host: "example.com",
      raw: "RemoteHost=alice@example.com",
    });
    const base64 = Buffer.from("hello", "utf8").toString("base64");
    expect(decodeOSC({ code: 1337, payload: `SetUserVar=greeting=${base64}` })).toEqual({
      kind: "userVar",
      vendor: "iterm",
      name: "greeting",
      value: "hello",
      raw: `SetUserVar=greeting=${base64}`,
    });
    expect(decodeOSC({ code: 1337, payload: `Copy=:${base64}` })).toEqual({
      kind: "clipboard",
      selection: "",
      selections: [],
      data: base64,
    });
    expect(decodeOSC({ code: 1337, payload: "ShellIntegrationVersion=5" })).toEqual({
      kind: "shellIntegrationVersion",
      vendor: "iterm",
      version: "5",
      raw: "ShellIntegrationVersion=5",
    });
  });

  it("decodes OSC 777 notify; rxvt-perl extension", () => {
    expect(decodeOSC({ code: 777, payload: "notify;Build;ok" })).toMatchObject({
      kind: "notification",
      vendor: "rxvt",
      title: "Build",
      body: "ok",
    });
    // Unknown 777 prefixes (e.g. fictitious `urgency`) fall to unknown.
    expect(decodeOSC({ code: 777, payload: "urgency;push" })).toEqual({
      kind: "unknown",
      code: 777,
      payload: "urgency;push",
    });
  });

  it("decodes OSC 8 hyperlink open with id param", () => {
    expect(decodeOSC({ code: 8, payload: "id=42:foo=bar;https://example.com" })).toEqual({
      kind: "hyperlink",
      action: "open",
      uri: "https://example.com",
      id: "42",
      params: { id: "42", foo: "bar" },
    });
  });

  it("decodes OSC 8 hyperlink close (empty uri) as action=close", () => {
    expect(decodeOSC({ code: 8, payload: ";" })).toEqual({
      kind: "hyperlink",
      action: "close",
      uri: "",
      params: {},
    });
  });

  it("decodes OSC 52 clipboard set, query, and clear", () => {
    expect(decodeOSC({ code: 52, payload: "c;aGVsbG8=" })).toEqual({
      kind: "clipboard",
      selection: "c",
      selections: ["c"],
      data: "aGVsbG8=",
    });
    expect(decodeOSC({ code: 52, payload: "p;?" })).toEqual({
      kind: "clipboard",
      selection: "p",
      selections: ["p"],
      query: true,
    });
    // Multi-char selection
    expect(decodeOSC({ code: 52, payload: "cs;aGk=" })).toMatchObject({
      selection: "cs",
      selections: ["c", "s"],
      data: "aGk=",
    });
    // Pd not base64, not `?` → clear
    expect(decodeOSC({ code: 52, payload: "c;not!base64" })).toEqual({
      kind: "clipboard",
      selection: "c",
      selections: ["c"],
      clear: true,
    });
    // Empty Pc — defaults to s0 per spec; we surface as empty selection/selections
    expect(decodeOSC({ code: 52, payload: ";aGk=" })).toMatchObject({
      selection: "",
      selections: [],
      data: "aGk=",
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
