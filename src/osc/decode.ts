import type {
  CustomDecodedOSC,
  DecodedOSC,
  OSCDecoderFn,
  OSCDecoderMap,
  OSCEvent,
} from "./types.ts";

// --- Built-in decoders ---

const titleDecoder: OSCDecoderFn<DecodedOSC> = (payload, event) => ({
  kind: "title",
  code: event.code as 0 | 1 | 2,
  title: payload,
});

const cwdDecoder: OSCDecoderFn<DecodedOSC> = (payload) => {
  // file://<host><path>
  const m = /^file:\/\/([^/]*)(\/.*)?$/.exec(payload);
  if (m) return { kind: "cwd", uri: payload, host: m[1] || undefined, path: m[2] };
  return { kind: "cwd", uri: payload };
};

const shellIntegrationDecoder =
  (vendor: "vt" | "vscode"): OSCDecoderFn<DecodedOSC> =>
  (payload) => {
    // OSC 133/633 ; <command> [; <data>]
    const [cmd, ...rest] = payload.split(";");
    return {
      kind: "shellIntegration",
      vendor,
      command: cmd ?? "",
      data: rest.join(";"),
    };
  };

const osc9Decoder: OSCDecoderFn<DecodedOSC> = (payload) => {
  // `9;4;...` is ConEmu/Windows-Terminal progress.
  if (payload.startsWith("4;")) {
    const parts = payload.split(";");
    return {
      kind: "progress",
      state: Number(parts[1] ?? 0),
      value: Number(parts[2] ?? 0),
    };
  }
  // `9;9;...` is a ConEmu/Windows-Terminal notification/message.
  if (payload.startsWith("9;")) {
    return { kind: "notification", vendor: "conemu", body: payload.slice(2), raw: payload };
  }
  return { kind: "notification", vendor: "iterm", body: payload, raw: payload };
};

const osc99Decoder: OSCDecoderFn<DecodedOSC> = (payload) => {
  // OSC 99 kitty-style notifications: `<k=v[:k=v]*>;<value>`
  const semi = payload.indexOf(";");
  const meta = semi >= 0 ? payload.slice(0, semi) : payload;
  const value = semi >= 0 ? payload.slice(semi + 1) : "";
  const fields = Object.fromEntries(
    meta.split(":").map((kv) => {
      const eq = kv.indexOf("=");
      return eq >= 0 ? [kv.slice(0, eq), kv.slice(eq + 1)] : [kv, ""];
    }),
  );
  const which = fields.p; // "title" | "body" | "done"
  if (which === "title") {
    return { kind: "notification", vendor: "kitty", title: value, raw: payload };
  }
  if (which === "body") {
    return { kind: "notification", vendor: "kitty", body: value, raw: payload };
  }
  return { kind: "notification", vendor: "kitty", raw: payload };
};

const osc1337Decoder: OSCDecoderFn<DecodedOSC> = (payload, event) => {
  // iTerm2 control sequences (`Key=Value` form)
  if (payload === "RequestAttention" || payload.startsWith("RequestAttention=")) {
    const value = payload.includes("=") ? payload.slice(payload.indexOf("=") + 1) : "yes";
    const action = value === "no" ? "cancel" : "request";
    return {
      kind: "attention",
      vendor: "iterm",
      action,
      ...(value === "fireworks" ? { effect: "fireworks" } : {}),
      value,
      raw: payload,
    };
  }
  if (payload.startsWith("notify;")) {
    // Format: "notify;title=<t>;body=<b>" or "notify;<msg>"
    const body = payload.slice("notify;".length);
    const parts = body.split(";");
    let title: string | undefined;
    let bodyText: string | undefined;
    for (const p of parts) {
      if (p.startsWith("title=")) title = p.slice("title=".length);
      else if (p.startsWith("body=")) bodyText = p.slice("body=".length);
      else if (!title) title = p;
    }
    return { kind: "notification", vendor: "iterm", title, body: bodyText, raw: payload };
  }
  return { kind: "unknown", code: event.code, payload };
};

const osc777Decoder: OSCDecoderFn<DecodedOSC> = (payload, event) => {
  // rxvt-style: `urgency;push`, `urgency;pop`, or `notify;<title>;<body>`
  if (payload === "urgency" || payload.startsWith("urgency;")) {
    const action = payload.split(";")[1] || "push";
    return { kind: "attention", vendor: "rxvt", action, raw: payload };
  }
  if (payload.startsWith("notify;")) {
    const parts = payload.split(";");
    return {
      kind: "notification",
      vendor: "rxvt",
      title: parts[1] ?? "",
      body: parts.slice(2).join(";"),
      raw: payload,
    };
  }
  return { kind: "unknown", code: event.code, payload };
};

// OSC 8: `8 ; params ; URI`. Empty URI closes the active hyperlink.
// params is `key=value[:key=value]*`, conventionally including `id=<n>`.
const hyperlinkDecoder: OSCDecoderFn<DecodedOSC> = (payload) => {
  const semi = payload.indexOf(";");
  const paramStr = semi >= 0 ? payload.slice(0, semi) : "";
  const uri = semi >= 0 ? payload.slice(semi + 1) : "";
  const params: Record<string, string> = {};
  if (paramStr) {
    for (const kv of paramStr.split(":")) {
      if (!kv) continue;
      const eq = kv.indexOf("=");
      if (eq >= 0) params[kv.slice(0, eq)] = kv.slice(eq + 1);
      else params[kv] = "";
    }
  }
  return params.id !== undefined
    ? { kind: "hyperlink", uri, id: params.id, params }
    : { kind: "hyperlink", uri, params };
};

// OSC 52: clipboard. Payload is `Pc ; Pd` where Pc is the selection
// (`c`, `p`, `q`, `s`, or digits `0..7`) and Pd is base64 data or `?` to query.
const clipboardDecoder: OSCDecoderFn<DecodedOSC> = (payload) => {
  const semi = payload.indexOf(";");
  const selection = semi >= 0 ? payload.slice(0, semi) : payload;
  const value = semi >= 0 ? payload.slice(semi + 1) : "";
  if (value === "?") return { kind: "clipboard", selection, query: true };
  return { kind: "clipboard", selection, data: value };
};

/**
 * Built-in OSC decoders keyed by code. Exposed so callers can inspect,
 * reuse, or layer their own decoders on top via {@link createOSCDecoder}.
 *
 * Mutating this object is supported but considered a global side-effect —
 * prefer passing custom decoders to {@link createOSCDecoder} instead.
 */
export const builtinOSCDecoders: OSCDecoderMap<DecodedOSC> = {
  0: titleDecoder,
  1: titleDecoder,
  2: titleDecoder,
  7: cwdDecoder,
  8: hyperlinkDecoder,
  9: osc9Decoder,
  52: clipboardDecoder,
  99: osc99Decoder,
  133: shellIntegrationDecoder("vt"),
  633: shellIntegrationDecoder("vscode"),
  777: osc777Decoder,
  1337: osc1337Decoder,
};

/**
 * Build a decoder function that runs custom decoders first, then falls back
 * to the built-ins, then to `{ kind: "unknown", code, payload }`.
 *
 * Custom decoders may register handlers for any OSC code — including unknown
 * ones — and may override built-in codes. The returned type is the union of
 * {@link DecodedOSC} and every custom decoder's return type, so the result
 * is fully typed in user code.
 *
 * @example
 * ```ts
 * const decode = createOSCDecoder({
 *   50:   (p) => ({ kind: "screen-mode", mode: p } as const),
 *   1234: (p, e) => ({ kind: "x", code: e.code, raw: p } as const),
 * });
 *
 * const d = decode(event);
 * // d is DecodedOSC | { kind: "screen-mode"; ... } | { kind: "x"; ... }
 * ```
 */
export function createOSCDecoder(): (event: OSCEvent) => DecodedOSC;
export function createOSCDecoder<Map extends Record<number, OSCDecoderFn<unknown>>>(
  custom: Map,
): (event: OSCEvent) => DecodedOSC | CustomDecodedOSC<Map>;
export function createOSCDecoder(
  custom?: Record<number, OSCDecoderFn<unknown>>,
): (event: OSCEvent) => unknown {
  if (!custom) return decodeBuiltin;
  return (event) => {
    const fn = custom[event.code];
    if (fn) return fn(event.payload, event);
    return decodeBuiltin(event);
  };
}

function decodeBuiltin(event: OSCEvent): DecodedOSC {
  const fn = builtinOSCDecoders[event.code];
  if (fn) return fn(event.payload, event);
  return { kind: "unknown", code: event.code, payload: event.payload };
}

/**
 * Decode a raw OSC event into a typed shape for well-known codes.
 *
 * Returns `{ kind: "unknown", code, payload }` for unrecognized codes — the
 * raw event is always preserved so callers can implement custom decoders
 * (see {@link createOSCDecoder} for extending the decoder with new codes).
 */
export const decodeOSC: (event: OSCEvent) => DecodedOSC = decodeBuiltin;
