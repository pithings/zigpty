#!/usr/bin/env bun
/**
 * OSC / escape-sequence demo — emits OS attention & notification signals.
 *
 * Cross-platform replacement for osc-demo.sh. Run directly via bun or via
 * node ≥22.6 with --experimental-strip-types. The output is identical to the
 * bash version so the OSC inspector can parse the same sequences anywhere.
 *
 *   bun scripts/osc-demo.ts
 *   DELAY=0.05 bun scripts/osc-demo.ts
 */
import * as os from "node:os";

const DELAY = Number(process.env.DELAY ?? "1");
const sleep = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));
const out = (s: string) => process.stdout.write(s);

out("=== Window Title ===\n");
out("\x1b]0;zigpty demo — window title\x07");
out("\x1b]2;zigpty demo — title only\x07");
out("\x1b]1;zigpty-tab\x07");

out("=== Current Working Directory (OSC 7) ===\n");
out(`\x1b]7;file://${os.hostname()}${process.cwd()}\x07`);

out("=== Shell Integration Marks (OSC 133) ===\n");
out("\x1b]133;A\x07");
out("\x1b]133;B\x07");
out("\x1b]133;C\x07");
out("\x1b]133;D;0\x07");

out("=== VS Code Shell Integration (OSC 633) ===\n");
out("\x1b]633;A\x07");
out("\x1b]633;B\x07");
out("\x1b]633;E;echo hello\x07");
out("\x1b]633;C\x07");
out("hello\n");
out("\x1b]633;D;0\x07");
out(`\x1b]633;P;Cwd=${process.cwd()}\x07`);

out("=== BEL (Bell) ===\n");
out("\x07");

out("=== Urgent / Window Attention ===\n");
out("\x1b]1337;RequestAttention=yes\x07");
out("\x1b]1337;RequestAttention=fireworks\x07");
out("\x1b]777;urgency;push\x1b\\");

out("=== Desktop Notifications ===\n");
out("\x1b]9;Build finished\x07");
out("\x1b]99;i=1:p=title;Build Status\x1b\\");
out("\x1b]99;i=1:p=body;All tests passed\x1b\\");
out("\x1b]99;i=1:p=done\x1b\\");
out("\x1b]777;notify;Build;Tests passed\x1b\\");
out("\x1b]1337;notify;title=Build;body=Tests passed\x07");
if (process.env.TMUX) {
  out("\x1bPtmux;\x1b\x1b]9;Build finished (via tmux)\x07\x1b\\");
}

out("=== Progress Indicators ===\n");
out("\x1b]9;4;3;0\x1b\\");
await sleep(0.5);
for (const pct of [0, 10, 25, 50, 75, 90, 100]) {
  out(`\x1b]9;4;1;${pct}\x1b\\`);
  await sleep(0.3);
}
out("\x1b]9;4;2;100\x1b\\");
await sleep(0.5);
out("\x1b]9;4;4;75\x1b\\");
await sleep(0.5);
out("\x1b]9;4;0;0\x1b\\");
await sleep(DELAY);

out("=== Done ===\n");
