/**
 * OSC (Operating System Command) parsing & decoding.
 *
 * - {@link OSCInspector} — byte-fed state machine; `feed(data)` + `on(listener)`
 * - {@link decodeOSC} / {@link createOSCDecoder} — turn raw events into typed shapes
 * - {@link builtinOSCDecoders} — registry of well-known codes (extensible)
 */
export { OSCInspector } from "./inspector.ts";
export { builtinOSCDecoders, createOSCDecoder, decodeOSC } from "./decode.ts";
export type {
  CustomDecodedOSC,
  DecodedOSC,
  OSCDecoderFn,
  OSCDecoderMap,
  OSCEvent,
  OSCListener,
  OSCState,
  OSCStateListener,
} from "./types.ts";
