import { Buffer } from "node:buffer";
import type { IPtyConsumer } from "../pty/types.ts";
import type { OSCEvent, OSCListener } from "./types.ts";

const MAX_PAYLOAD = 4096;

const Ground = 0;
const Esc = 1;
const Osc = 2;
const OscSt = 3;
type State = 0 | 1 | 2 | 3;

/**
 * Pure-TS OSC (Operating System Command) inspector.
 *
 * Feed any byte stream — typically a PTY's data stream — and receive a
 * callback per recognized OSC sequence. The parser is a byte-fed state
 * machine, so sequences split across feed calls are stitched back together.
 *
 * @example
 * ```ts
 * const inspector = new OSCInspector((event) => {
 *   console.log(`OSC ${event.code}: ${event.payload}`);
 * });
 * pty.attach(inspector);
 * ```
 */
export class OSCInspector implements IPtyConsumer {
  private _state: State = Ground;
  private _buf = Buffer.allocUnsafe(MAX_PAYLOAD);
  private _len = 0;
  private _overflow = false;
  private _listeners: OSCListener[] = [];

  constructor(listener?: OSCListener) {
    if (listener) this._listeners.push(listener);
  }

  /** Subscribe to OSC events. Returns a disposer. */
  on(listener: OSCListener): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  /** Feed bytes into the parser. Accepts string (utf-8), Buffer, or Uint8Array. */
  feed(data: string | Buffer | Uint8Array): void {
    const bytes =
      typeof data === "string"
        ? Buffer.from(data, "utf8")
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < bytes.length; i++) this._feedByte(bytes[i]!);
  }

  /** Drop all listeners and reset parser state. */
  dispose(): void {
    this._listeners.length = 0;
    this._state = Ground;
    this._len = 0;
    this._overflow = false;
  }

  private _feedByte(b: number): void {
    // CAN (0x18) and SUB (0x1a) cancel any in-progress escape sequence.
    if (b === 0x18 || b === 0x1a) {
      this._state = Ground;
      this._len = 0;
      this._overflow = false;
      return;
    }
    switch (this._state) {
      case Ground:
        if (b === 0x1b) this._state = Esc;
        return;
      case Esc:
        if (b === 0x5d) {
          this._state = Osc;
          this._len = 0;
          this._overflow = false;
        } else if (b !== 0x1b) {
          this._state = Ground;
        }
        return;
      case Osc:
        if (b === 0x07) {
          this._finish();
        } else if (b === 0x1b) {
          this._state = OscSt;
        } else if (!this._overflow) {
          if (this._len === MAX_PAYLOAD) {
            this._overflow = true;
          } else {
            this._buf[this._len++] = b;
          }
        }
        return;
      case OscSt:
        if (b === 0x5c) {
          this._finish();
        } else if (b === 0x1b) {
          // Stray ESC — abort current sequence but treat this ESC as the start
          // of a potential next one (so ESC ] re-enters OSC cleanly).
          this._state = Esc;
          this._len = 0;
          this._overflow = false;
        } else {
          this._state = Ground;
          this._len = 0;
          this._overflow = false;
        }
        return;
    }
  }

  private _finish(): void {
    if (!this._overflow && this._len > 0) {
      const data = this._buf.toString("utf8", 0, this._len);
      let code = -1;
      let payload = data;
      const semi = data.indexOf(";");
      const codeStr = semi >= 0 ? data.slice(0, semi) : data;
      if (codeStr.length > 0 && /^\d+$/.test(codeStr)) {
        code = Number(codeStr);
        payload = semi >= 0 ? data.slice(semi + 1) : "";
      } else if (codeStr.length === 0) {
        payload = semi >= 0 ? data.slice(semi + 1) : "";
      }
      const event: OSCEvent = { code, payload };
      for (const l of this._listeners) {
        try {
          l(event);
        } catch {
          // Swallow listener errors — never let one break parsing.
        }
      }
    }
    this._state = Ground;
    this._len = 0;
    this._overflow = false;
  }
}
