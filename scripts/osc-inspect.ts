#!/usr/bin/env bun
/**
 * Demo: drive scripts/osc-demo.ts through a PTY, parse OSC sequences with
 * the native inspector, and pretty-print each decoded event.
 *
 *   bun scripts/osc-inspect.ts
 *   bun scripts/osc-inspect.ts --raw           # only the raw {code,payload}
 *   bun scripts/osc-inspect.ts -- some-script  # inspect a different script
 *
 * Cross-platform: the demo script is TypeScript, spawned via whatever
 * runtime is executing this file (bun directly; node ≥22.6 with
 * --experimental-strip-types added automatically).
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "../src/index.ts";
import { OSCInspector, createOSCDecoder, type DecodedOSC } from "../src/osc/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const raw = argv.includes("--raw");
const positional = argv.filter((a) => !a.startsWith("--"));
const script = positional[0] ?? path.join(here, "osc-demo.ts");

// Custom decoder demonstrates extensibility — handle a fake vendor code in
// addition to all built-ins. Anything not in `custom` falls back to the
// built-in decoders, then to `{ kind: "unknown" }`.
const decode = createOSCDecoder({
  1338: (payload) => ({ kind: "demo-vendor" as const, payload }),
});

const inspector = new OSCInspector((event) => {
  if (raw) {
    process.stdout.write(`OSC ${event.code}\t${JSON.stringify(event.payload)}\n`);
    return;
  }
  const decoded = decode(event);
  process.stdout.write(format(decoded, event.code) + "\n");
});

const { file, args } = resolveRunner(script);

const pty = spawn(file, args, {
  cols: 120,
  rows: 40,
  env: { ...process.env, DELAY: "0.05", TERM: "xterm-256color" } as Record<string, string>,
});

// Attach the inspector to the pty: equivalent to `pty.onData(d => inspector.feed(d))`
// but the inspector is automatically detached when the pty exits.
pty.attach(inspector);

const code = await pty.exited;
process.exit(code);

/**
 * Pick the runtime that should execute the demo script.
 *
 * - `.sh` → bash (legacy support)
 * - `.ts`/`.mts`/`.cts` → current runtime: bun runs TS natively; node needs
 *   `--experimental-strip-types` (added on node ≥22.6).
 * - everything else → handed to the current runtime as-is.
 */
function resolveRunner(scriptPath: string): { file: string; args: string[] } {
  const ext = path.extname(scriptPath).toLowerCase();
  if (ext === ".sh") {
    return { file: process.platform === "win32" ? "bash.exe" : "/bin/bash", args: [scriptPath] };
  }
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  const isTs = ext === ".ts" || ext === ".mts" || ext === ".cts";
  const args = isTs && !isBun ? ["--experimental-strip-types", scriptPath] : [scriptPath];
  return { file: process.execPath, args };
}

type Decoded = DecodedOSC | { kind: "demo-vendor"; payload: string };

function format(d: Decoded, code: number): string {
  switch (d.kind) {
    case "title":
      return `[title ${d.code}] ${d.title}`;
    case "cwd":
      return `[cwd:${d.source}] ${d.path}${d.host ? `  @${d.host}` : ""}`;
    case "shellIntegration":
      return `[${d.vendor}-integration ${d.command}]${d.data ? ` ${d.data}` : ""}`;
    case "notification": {
      const parts = [d.title, d.body].filter(Boolean).join(" — ");
      return `[notify:${d.vendor}] ${parts || d.raw}`;
    }
    case "progress":
      return `[progress] state=${d.state}${d.value !== undefined ? ` value=${d.value}` : ""}`;
    case "attention":
      return `[attention] ${d.raw}`;
    case "hyperlink":
      return d.action === "close"
        ? `[hyperlink:close]`
        : `[hyperlink${d.id ? ` id=${d.id}` : ""}] ${d.uri}`;
    case "clipboard":
      if (d.query) return `[clipboard:${d.selection}] ?`;
      if (d.clear) return `[clipboard:${d.selection}] <clear>`;
      return `[clipboard:${d.selection}] ${d.data ?? ""}`;
    case "mark":
      return `[mark:${d.vendor}]`;
    case "userVar":
      return `[userVar:${d.vendor}] ${d.name}=${d.value}`;
    case "remoteHost":
      return `[remoteHost:${d.vendor}] ${d.user ? `${d.user}@` : ""}${d.host}`;
    case "shellIntegrationVersion":
      return `[shellIntegrationVersion:${d.vendor}] ${d.version}`;
    case "demo-vendor":
      return `[demo-vendor] ${d.payload}`;
    case "unknown":
      return `[osc ${code}] ${d.payload}`;
  }
}
