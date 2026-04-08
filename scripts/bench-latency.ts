import { performance } from "node:perf_hooks";
import { spawn } from "../src/index.ts";

type IterationResult = {
  spawnToFirstMs: number;
  roundTripMs: number;
};

const DEFAULT_ITERATIONS = 30;
const DEFAULT_TIMEOUT_MS = 5000;

async function main(): Promise<void> {
  if (process.platform === "win32") {
    throw new Error("bench-latency currently supports Unix only");
  }

  const iterationsArg = Number.parseInt(process.argv[2] ?? "", 10);
  const iterations = Number.isFinite(iterationsArg) && iterationsArg > 0 ? iterationsArg : DEFAULT_ITERATIONS;
  const timeoutArg = Number.parseInt(process.argv[3] ?? "", 10);
  const timeoutMs = Number.isFinite(timeoutArg) && timeoutArg > 0 ? timeoutArg : DEFAULT_TIMEOUT_MS;

  const results: IterationResult[] = [];

  for (let i = 0; i < iterations; i++) {
    const result = await runIteration(i, timeoutMs);
    results.push(result);
    console.log(
      `iter ${String(i + 1).padStart(2, "0")}/${iterations}: ` +
      `spawn->first=${result.spawnToFirstMs.toFixed(3)}ms ` +
      `roundtrip=${result.roundTripMs.toFixed(3)}ms`,
    );
  }

  const spawnMetrics = summarize(results.map((r) => r.spawnToFirstMs));
  const roundTripMetrics = summarize(results.map((r) => r.roundTripMs));

  console.log("");
  console.log(`iterations: ${iterations}`);
  printMetrics("spawn_to_first_ms", spawnMetrics);
  printMetrics("write_roundtrip_ms", roundTripMetrics);
}

async function runIteration(iteration: number, timeoutMs: number): Promise<IterationResult> {
  const nonce = `${Date.now()}_${process.pid}_${iteration}`;
  const readyMarker = `__zigpty_ready_${nonce}__`;
  const echoMarker = `__zigpty_echo_${nonce}__`;

  const tSpawn = performance.now();
  const pty = spawn("/bin/sh", ["-c", `printf '${readyMarker}\\n'; exec cat`], { cols: 80, rows: 24 });

  let firstChunkAt: number | null = null;
  let output = "";
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let resolveEcho!: () => void;
  let rejectEcho!: (err: Error) => void;
  const echoPromise = new Promise<void>((resolve, reject) => {
    resolveEcho = resolve;
    rejectEcho = reject;
  });
  echoPromise.catch(() => {}); // prevent unhandled rejection on early exit

  let wroteMarker = false;

  const onDataDisposable = pty.onData((data) => {
    const now = performance.now();
    if (firstChunkAt === null) {
      firstChunkAt = now;
    }

    const text = typeof data === "string" ? data : data.toString("utf8");
    output += text;

    if (output.includes(readyMarker)) {
      resolveReady();
    }
    if (wroteMarker && output.includes(echoMarker)) {
      resolveEcho();
    }
  });

  const onExitDisposable = pty.onExit((info) => {
    const message = `pty exited early (exitCode=${info.exitCode}, signal=${info.signal})`;
    rejectReady(new Error(message));
    rejectEcho(new Error(message));
  });

  const readyTimer = setTimeout(() => {
    rejectReady(new Error(`timeout waiting for ready marker after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    await readyPromise;
  } finally {
    clearTimeout(readyTimer);
  }

  const spawnToFirstMs = (firstChunkAt ?? performance.now()) - tSpawn;

  const tWrite = performance.now();
  wroteMarker = true;
  pty.write(`${echoMarker}\n`);

  const echoTimer = setTimeout(() => {
    rejectEcho(new Error(`timeout waiting for echo marker after ${timeoutMs}ms`));
  }, timeoutMs);

  let roundTripMs = 0;
  try {
    await echoPromise;
    roundTripMs = performance.now() - tWrite;
  } finally {
    clearTimeout(echoTimer);
    onDataDisposable.dispose();
    onExitDisposable.dispose();
    try {
      pty.close();
    } catch {}
    await Promise.race([pty.exited.catch(() => undefined), sleep(50)]);
  }

  return { spawnToFirstMs, roundTripMs };
}

function summarize(values: number[]): { min: number; max: number; avg: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const sum = values.reduce((acc, value) => acc + value, 0);
  const avg = values.length > 0 ? sum / values.length : 0;
  const p95 = percentile(sorted, 95);
  return { min, max, avg, p95 };
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedValues.length) - 1;
  const index = Math.max(0, Math.min(rank, sortedValues.length - 1));
  return sortedValues[index]!;
}

function printMetrics(label: string, metrics: { min: number; max: number; avg: number; p95: number }): void {
  console.log(
    `${label}: min=${metrics.min.toFixed(3)} avg=${metrics.avg.toFixed(3)} ` +
    `max=${metrics.max.toFixed(3)} p95=${metrics.p95.toFixed(3)} ms`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
