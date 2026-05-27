/** Raw OSC event emitted by the parser. */
export interface OSCEvent {
  /** Numeric OSC code (e.g. 0, 7, 133, 633, 9, 99, 1337). `-1` if absent. */
  code: number;
  /** Raw payload after the leading `code;` (or the whole body if no `;`). */
  payload: string;
}

/** Decoded shapes for well-known OSC codes. */
export type DecodedOSC =
  | { kind: "title"; code: 0 | 1 | 2; title: string }
  | {
      kind: "cwd";
      /** Where this CWD was reported from. */
      source: "osc7" | "conemu" | "iterm";
      /** Decoded filesystem path (percent-decoded for OSC 7). */
      path: string;
      /** Raw URI — only present for OSC 7. */
      uri?: string;
      /** URI scheme (`file`, `kitty-shell-cwd`, …) — only present for OSC 7. */
      scheme?: string;
      /** Host from the OSC 7 URI authority — `undefined` when empty. */
      host?: string;
      /** True when `host` is empty or `localhost` (OSC 7). */
      local?: boolean;
    }
  | {
      kind: "shellIntegration";
      vendor: "vt" | "vscode";
      /** Sub-command letter or word (e.g. `A`, `B`, `C`, `D`, `EnvSingleStart`). */
      command: string;
      /** Remainder after the command, joined by `;`. Empty when no data. */
      data: string;
      /** Parsed exit code for `D`. */
      exitCode?: number;
      /** Parsed `err=` value for OSC 133 `D` (empty string = success). */
      err?: string;
      /** Parsed `key=value` extras (kitty `A`/`C`; vscode `P`). */
      params?: Record<string, string>;
      /** Parsed key for vscode `P;<Key>=<Value>` / `EnvSingleEntry`. */
      key?: string;
      /** Parsed value for vscode `P;<Key>=<Value>` / `EnvSingleEntry`. */
      value?: string;
      /** Parsed command line for vscode `E`. */
      commandLine?: string;
      /** Parsed nonce for vscode `E` / `EnvSingle*`. */
      nonce?: string;
      /** Index for vscode `EnvSingleStart`. */
      index?: number;
    }
  | {
      kind: "notification";
      vendor: "iterm" | "conemu" | "kitty" | "rxvt";
      title?: string;
      body?: string;
      /** kitty: notification identifier ties chunks together. */
      id?: string;
      /** kitty: 0=low, 1=normal, 2=critical. */
      urgency?: 0 | 1 | 2;
      /** kitty: `d=0` — more chunks pending. */
      partial?: boolean;
      /** kitty: non-payload phase (`close`, `alive`, `icon`, `buttons`, `?`). */
      phase?: string;
      raw: string;
    }
  | {
      kind: "progress";
      /** 0=remove, 1=normal, 2=error, 3=indeterminate, 4=paused. */
      state: number;
      /** 0-100. Omitted for states 0/3 and optional for 2/4. */
      value?: number;
    }
  | {
      kind: "attention";
      vendor: "iterm";
      action: "request" | "cancel";
      effect?: "fireworks" | "once";
      value: string;
      raw: string;
    }
  | {
      kind: "hyperlink";
      /** `open` = active hyperlink begins; `close` = empty-URI terminator. */
      action: "open" | "close";
      uri: string;
      id?: string;
      params: Record<string, string>;
    }
  | {
      kind: "clipboard";
      /** Raw `Pc` field (may be empty for default `s0`, may be multi-char). */
      selection: string;
      /** `Pc` split into individual selection chars (`cs` → `['c','s']`). */
      selections: string[];
      /** Base64-encoded data (when setting). */
      data?: string;
      /** True for `?` query. */
      query?: boolean;
      /** True when `Pd` is neither base64 nor `?` (xterm-spec: clear clipboard). */
      clear?: boolean;
    }
  | { kind: "mark"; vendor: "iterm" | "conemu"; raw: string }
  | {
      kind: "userVar";
      vendor: "iterm";
      name: string;
      /** Base64-decoded value. */
      value: string;
      raw: string;
    }
  | {
      kind: "remoteHost";
      vendor: "iterm";
      user?: string;
      host: string;
      raw: string;
    }
  | {
      kind: "shellIntegrationVersion";
      vendor: "iterm";
      version: string;
      raw: string;
    }
  | { kind: "unknown"; code: number; payload: string };

/** Listener for raw OSC events. */
export type OSCListener = (event: OSCEvent) => void;

/**
 * Terminal state derived from OSC sequences seen so far.
 *
 * Populated by {@link OSCInspector} as it parses incoming bytes. Only
 * sequences that represent durable, observable state are folded in here —
 * action-like sequences (clipboard writes, notifications, marks, attention
 * requests) are still emitted to listeners but don't update state.
 */
export interface OSCState {
  /** Window title — last value from OSC 0 or OSC 2. */
  title?: string;
  /** Icon / tab name — last value from OSC 0 or OSC 1. */
  iconName?: string;
  /** Current working directory — from OSC 7, OSC 1337 `CurrentDir`, or OSC 9;9. */
  cwd?: {
    path: string;
    source: "osc7" | "conemu" | "iterm";
    /** Host from the OSC 7 URI authority (only when present and non-empty). */
    host?: string;
  };
  /** Active hyperlink between OSC 8 open and OSC 8 close. */
  hyperlink?: {
    uri: string;
    id?: string;
    params: Record<string, string>;
  };
  /** Latest taskbar progress (OSC 9;4). Cleared when state 0 is reported. */
  progress?: {
    state: number;
    value?: number;
  };
  /** Remote host (OSC 1337 `RemoteHost`). */
  remoteHost?: {
    user?: string;
    host: string;
  };
  /** iTerm shell-integration version (OSC 1337 `ShellIntegrationVersion`). */
  shellIntegrationVersion?: string;
  /** User-defined variables set via OSC 1337 `SetUserVar`. */
  userVars?: Record<string, string>;
}

/** Listener for state changes. Called after each OSC sequence that mutated state. */
export type OSCStateListener = (state: Readonly<OSCState>) => void;

/** Signature for an OSC decoder. `payload` is split out for ergonomics. */
export type OSCDecoderFn<T> = (payload: string, event: OSCEvent) => T;

/** A map of OSC code → decoder. Used by both built-ins and custom decoders. */
export type OSCDecoderMap<T> = Record<number, OSCDecoderFn<T>>;

/** Union of return types from a custom decoder map — used to type the result of {@link createOSCDecoder}. */
export type CustomDecodedOSC<Map> = Map[keyof Map] extends (...args: never) => infer R ? R : never;
