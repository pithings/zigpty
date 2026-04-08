import { parseArgs } from "node:util";
import { spawn, hasNative } from "../src/index.ts";

const { values } = parseArgs({
  options: {
    pipe: { type: "boolean", default: false },
    shell: { type: "string", default: process.env.SHELL || "/bin/sh" },
  },
  allowPositionals: false,
});

const shell = values.shell!;
const usePipe = values.pipe!;

console.log(`Spawning ${shell} (native: ${hasNative}, pipe: ${usePipe})`);

const pty = spawn(shell, [], {
  cols: process.stdout.columns || 80,
  rows: process.stdout.rows || 24,
  pipe: usePipe,
  env: {
    ...(process.env as Record<string, string>),
    PS1: `\x1b[33m[zigpty]\x1b[0m $ `,
  },
});

// PTY → stdout
pty.onData((data) => {
  process.stdout.write(data);
});

// stdin → PTY
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (data: Buffer) => {
  pty.write(data.toString());
});

// Handle terminal resize
process.stdout.on("resize", () => {
  pty.resize(process.stdout.columns, process.stdout.rows);
});

// Clean exit
pty.onExit(({ exitCode }) => {
  process.stdin.setRawMode(false);
  process.exit(exitCode);
});
