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
  | { kind: "cwd"; uri: string; host?: string; path?: string }
  | { kind: "shellIntegration"; vendor: "vt" | "vscode"; command: string; data: string }
  | {
      kind: "notification";
      vendor: string;
      title?: string;
      body?: string;
      done?: boolean;
      raw: string;
    }
  | { kind: "progress"; state: number; value: number }
  | {
      kind: "attention";
      raw: string;
      vendor?: "iterm" | "rxvt" | string;
      action?: "request" | "cancel" | "push" | "pop" | string;
      effect?: "fireworks" | string;
      value?: string;
    }
  | { kind: "hyperlink"; uri: string; id?: string; params: Record<string, string> }
  | { kind: "clipboard"; selection: string; data?: string; query?: boolean }
  | { kind: "unknown"; code: number; payload: string };

/** Listener for raw OSC events. */
export type OSCListener = (event: OSCEvent) => void;

/** Signature for an OSC decoder. `payload` is split out for ergonomics. */
export type OSCDecoderFn<T> = (payload: string, event: OSCEvent) => T;

/** A map of OSC code → decoder. Used by both built-ins and custom decoders. */
export type OSCDecoderMap<T> = Record<number, OSCDecoderFn<T>>;

/** Union of return types from a custom decoder map — used to type the result of {@link createOSCDecoder}. */
export type CustomDecodedOSC<Map> = Map[keyof Map] extends (...args: never) => infer R ? R : never;
