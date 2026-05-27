import { Buffer } from "node:buffer";
import type {
  CustomDecodedOSC,
  DecodedOSC,
  OSCDecoderFn,
  OSCDecoderMap,
  OSCEvent,
} from "./types.ts";

// --- Shared helpers ---

// Strip C0 (0x00-0x1F) and DEL (0x7F). Real terminals do this for titles.
function stripControls(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional.
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}

function safeBase64Decode(s: string): string {
  try {
    return Buffer.from(s, "base64").toString("utf8");
  } catch {
    return s;
  }
}

// Strip a single surrounding pair of `"`. Used by ConEmu `OSC 9;9;"path"`.
function unquote(s: string): string {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
  return s;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// VSCode escape rules from `__vsc_escape_value` in shellIntegration-bash.sh:
// `\\` → `\`, `\xNN` → byte NN. Applied to vscode E/P/EnvSingleEntry values.
function vscodeUnescape(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x5c && i + 1 < s.length) {
      const n = s.charCodeAt(i + 1);
      if (n === 0x5c) {
        out += "\\";
        i += 2;
        continue;
      }
      if (n === 0x78 && i + 3 < s.length) {
        const hex = s.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
          continue;
        }
      }
    }
    out += s[i]!;
    i++;
  }
  return out;
}

// --- Built-in decoders ---

const titleDecoder: OSCDecoderFn<DecodedOSC> = (payload, event) => ({
  kind: "title",
  code: event.code as 0 | 1 | 2,
  title: stripControls(payload),
});

const cwdDecoder: OSCDecoderFn<DecodedOSC> = (payload) => {
  // `<scheme>://<host>/<path>` — VTE's vte-urlencode-cwd is the de-facto spec.
  // Path is RFC 3986 percent-encoded; we decode it for callers.
  const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^/]*)(\/.*)?$/.exec(payload);
  if (m) {
    const scheme = m[1]!;
    const host = m[2] || undefined;
    const rawPath = m[3] ?? "";
    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      path = rawPath;
    }
    return {
      kind: "cwd",
      source: "osc7",
      uri: payload,
      scheme,
      host,
      path,
      local: !host || host === "localhost",
    };
  }
  return { kind: "cwd", source: "osc7", uri: payload, path: payload };
};

const shellIntegrationDecoder =
  (vendor: "vt" | "vscode"): OSCDecoderFn<DecodedOSC> =>
  (payload) => {
    // OSC 133/633 ; <command> [; <data...>]
    const semi = payload.indexOf(";");
    const command = semi >= 0 ? payload.slice(0, semi) : payload;
    const data = semi >= 0 ? payload.slice(semi + 1) : "";
    const out: DecodedOSC = { kind: "shellIntegration", vendor, command, data };

    if (vendor === "vt") {
      // OSC 133 ; D [; <exitCode>] [; err=<value>]
      if (command === "D" && data) {
        const parts = data.split(";");
        const head = parts[0]!;
        if (/^\d+$/.test(head)) out.exitCode = Number(head);
        for (const p of parts) {
          if (p.startsWith("err=")) out.err = p.slice("err=".length);
        }
      }
      // OSC 133 ; A|C [; key=val[;key=val]...] — kitty extensions.
      if ((command === "A" || command === "C") && data) {
        const params: Record<string, string> = {};
        for (const p of data.split(";")) {
          const eq = p.indexOf("=");
          if (eq >= 0) params[p.slice(0, eq)] = p.slice(eq + 1);
        }
        if (Object.keys(params).length > 0) out.params = params;
      }
      return out;
    }

    // vendor === "vscode" — OSC 633
    if (command === "D" && data) {
      // OSC 633 ; D [; <exitCode>]
      if (/^\d+$/.test(data)) out.exitCode = Number(data);
    } else if (command === "P") {
      // OSC 633 ; P ; <Key>=<Value>
      const eq = data.indexOf("=");
      if (eq >= 0) {
        out.key = data.slice(0, eq);
        out.value = vscodeUnescape(data.slice(eq + 1));
      }
    } else if (command === "E") {
      // OSC 633 ; E ; <commandLine> [; <nonce>]
      const parts = data.split(";");
      out.commandLine = vscodeUnescape(parts[0] ?? "");
      if (parts.length > 1) out.nonce = parts[parts.length - 1];
    } else if (command === "EnvSingleStart") {
      // OSC 633 ; EnvSingleStart ; <index> ; <nonce>
      const parts = data.split(";");
      if (parts[0] && /^\d+$/.test(parts[0])) out.index = Number(parts[0]);
      if (parts[1]) out.nonce = parts[1];
    } else if (command === "EnvSingleEntry") {
      // OSC 633 ; EnvSingleEntry ; <key> ; <value> ; <nonce>
      const parts = data.split(";");
      if (parts[0]) out.key = parts[0];
      if (parts[1] !== undefined) out.value = vscodeUnescape(parts[1]);
      if (parts[2]) out.nonce = parts[2];
    } else if (command === "EnvSingleEnd") {
      out.nonce = data;
    }
    return out;
  };

// ConEmu sub-commands that are well-defined enough to recognize as "not iTerm".
const CONEMU_SUBCMDS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);

const osc9Decoder: OSCDecoderFn<DecodedOSC> = (payload, event) => {
  // ConEmu / Windows Terminal use `9;<sub>;<args>`. Sub-command numbers
  // documented at https://conemu.github.io/en/AnsiEscapeCodes.html
  const semi = payload.indexOf(";");
  const head = semi >= 0 ? payload.slice(0, semi) : payload;
  const rest = semi >= 0 ? payload.slice(semi + 1) : "";

  // `9;4;<state>[;<value>]` — taskbar progress.
  if (head === "4") {
    const parts = rest.split(";");
    const state = Number(parts[0] ?? 0);
    const valueRaw = parts[1];
    const out: DecodedOSC = { kind: "progress", state };
    if (valueRaw !== undefined && valueRaw !== "") out.value = Number(valueRaw);
    return out;
  }
  // `9;9;<cwd>` — Windows Terminal / ConEmu CWD report (NOT a notification).
  // See https://learn.microsoft.com/en-us/windows/terminal/tutorials/new-tab-same-directory
  if (head === "9") {
    return { kind: "cwd", source: "conemu", path: unquote(rest) };
  }
  // `9;12` — ConEmu prompt-start marker (shell-integration).
  if (head === "12") {
    return { kind: "mark", vendor: "conemu", raw: payload };
  }
  // Any other recognized ConEmu sub-command — surface as unknown, not as
  // an iTerm notification (the previous fallback misclassified these).
  if (CONEMU_SUBCMDS.has(head)) {
    return { kind: "unknown", code: event.code, payload };
  }
  // `9;<text>` with non-numeric head — iTerm2 Growl-style notification.
  return { kind: "notification", vendor: "iterm", body: payload, raw: payload };
};

const osc99Decoder: OSCDecoderFn<DecodedOSC> = (payload) => {
  // OSC 99: kitty desktop notifications.
  // Format: `<k=v[:k=v]*>;<value>`
  // See https://sw.kovidgoyal.net/kitty/desktop-notifications/
  const semi = payload.indexOf(";");
  const meta = semi >= 0 ? payload.slice(0, semi) : payload;
  const rawValue = semi >= 0 ? payload.slice(semi + 1) : "";
  const fields: Record<string, string> = {};
  for (const kv of meta.split(":")) {
    if (!kv) continue;
    const eq = kv.indexOf("=");
    if (eq >= 0) fields[kv.slice(0, eq)] = kv.slice(eq + 1);
    else fields[kv] = "";
  }
  const phase = fields.p ?? "title"; // title | body | close | alive | icon | buttons | ?
  const value = fields.e === "1" ? safeBase64Decode(rawValue) : rawValue;

  const out: DecodedOSC = { kind: "notification", vendor: "kitty", raw: payload };
  if (fields.i) out.id = fields.i;
  if (fields.u === "0" || fields.u === "1" || fields.u === "2") {
    out.urgency = Number(fields.u) as 0 | 1 | 2;
  }
  // d defaults to 1 (complete). Only flag the chunk if explicitly d=0.
  if (fields.d === "0") out.partial = true;

  if (phase === "title") out.title = value;
  else if (phase === "body") out.body = value;
  else out.phase = phase;
  return out;
};

const osc1337Decoder: OSCDecoderFn<DecodedOSC> = (payload, event) => {
  // iTerm2 OSC 1337 — see https://iterm2.com/documentation-escape-codes.html
  // Form: `<Command>[=<arg>]` (CamelCase command, optional `=value`).
  if (payload === "RequestAttention" || payload.startsWith("RequestAttention=")) {
    const value = payload.includes("=") ? payload.slice(payload.indexOf("=") + 1) : "yes";
    const action = value === "no" ? "cancel" : "request";
    const effect = value === "fireworks" || value === "once" ? value : undefined;
    return {
      kind: "attention",
      vendor: "iterm",
      action,
      ...(effect ? { effect } : {}),
      value,
      raw: payload,
    };
  }
  if (payload === "SetMark") {
    return { kind: "mark", vendor: "iterm", raw: payload };
  }
  if (payload.startsWith("CurrentDir=")) {
    return { kind: "cwd", source: "iterm", path: payload.slice("CurrentDir=".length) };
  }
  if (payload.startsWith("SetUserVar=")) {
    // SetUserVar=<name>=<base64>
    const rest = payload.slice("SetUserVar=".length);
    const eq = rest.indexOf("=");
    if (eq >= 0) {
      return {
        kind: "userVar",
        vendor: "iterm",
        name: rest.slice(0, eq),
        value: safeBase64Decode(rest.slice(eq + 1)),
        raw: payload,
      };
    }
  }
  if (payload.startsWith("RemoteHost=")) {
    const v = payload.slice("RemoteHost=".length);
    const at = v.indexOf("@");
    return {
      kind: "remoteHost",
      vendor: "iterm",
      ...(at >= 0 ? { user: v.slice(0, at), host: v.slice(at + 1) } : { host: v }),
      raw: payload,
    };
  }
  if (payload.startsWith("ShellIntegrationVersion=")) {
    return {
      kind: "shellIntegrationVersion",
      vendor: "iterm",
      version: payload.slice("ShellIntegrationVersion=".length),
      raw: payload,
    };
  }
  if (payload.startsWith("Copy=")) {
    // Copy=<selection>:<base64>
    const rest = payload.slice("Copy=".length);
    const colon = rest.indexOf(":");
    const sel = colon >= 0 ? rest.slice(0, colon) : "";
    const data = colon >= 0 ? rest.slice(colon + 1) : rest;
    return {
      kind: "clipboard",
      selection: sel,
      selections: sel ? [...sel] : [],
      data,
    };
  }
  return { kind: "unknown", code: event.code, payload };
};

const osc777Decoder: OSCDecoderFn<DecodedOSC> = (payload, event) => {
  // urxvt-perl extension dispatcher. The shipped `notify`/`osc-notify`
  // extension uses `notify;<title>;<body>`.
  if (payload.startsWith("notify;")) {
    const parts = payload.slice("notify;".length).split(";");
    return {
      kind: "notification",
      vendor: "rxvt",
      title: parts[0] ?? "",
      body: parts.slice(1).join(";"),
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
  const action = uri === "" ? "close" : "open";
  return params.id !== undefined
    ? { kind: "hyperlink", action, uri, id: params.id, params }
    : { kind: "hyperlink", action, uri, params };
};

// OSC 52: clipboard. Payload is `Pc ; Pd`.
// Pc is zero or more of `c` (clipboard), `p` (primary), `q` (secondary),
// `s` (select alias), or digits `0..7` (cut buffers). Multi-char values like
// `cs` are valid. Empty Pc defaults to `s0`.
// Pd is base64 data, `?` to query, or anything else to clear the clipboard.
const clipboardDecoder: OSCDecoderFn<DecodedOSC> = (payload) => {
  const semi = payload.indexOf(";");
  const selection = semi >= 0 ? payload.slice(0, semi) : payload;
  const value = semi >= 0 ? payload.slice(semi + 1) : "";
  const selections = selection ? [...selection] : [];
  if (value === "?") return { kind: "clipboard", selection, selections, query: true };
  if (!BASE64_RE.test(value)) return { kind: "clipboard", selection, selections, clear: true };
  return { kind: "clipboard", selection, selections, data: value };
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
