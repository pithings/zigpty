#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

PREBUILDS="$(pwd)/prebuilds"

# Test script that loads the native module and runs a basic PTY fork
read -r -d '' TEST_SCRIPT << 'EOF' || true
const tty = require("node:tty");
const fs = require("node:fs");

const files = fs.readdirSync("/app/prebuilds").filter(f => f.endsWith(".node"));
let native;
for (const f of files) {
  try {
    native = process.dlopen(module, "/app/prebuilds/" + f);
    native = module.exports;
    console.log("  loaded:", f);
    break;
  } catch {}
}
if (!native) { console.error("  FAIL: no compatible prebuild"); process.exit(1); }

// Test 1: open
const pair = native.open(80, 24);
console.log("  open(): master=%d slave=%d pty=%s", pair.master, pair.slave, pair.pty);

// Test 2: fork + exit callback
const result = native.fork(
  "/bin/sh", ["-c", "echo hello-zigpty && exit 0"],
  Object.entries(process.env).map(([k, v]) => k + "=" + v),
  "/tmp", 80, 24, -1, -1, true,
  (info) => {
    console.log("  exit: code=%d signal=%d", info.exitCode, info.signal);
    console.log("  PASS");
    process.exit(0);
  }
);
console.log("  fork(): pid=%d fd=%d", result.pid, result.fd);

// Read PTY output
const stream = new tty.ReadStream(result.fd);
stream.setEncoding("utf8");
stream.on("data", (data) => process.stdout.write("  output: " + data));
stream.on("error", () => {});
setTimeout(() => { console.log("  FAIL: timeout"); process.exit(1); }, 5000);
EOF

pass=0
fail=0
skip=0

run_test() {
  local label="$1" image="$2" platform="${3:-linux/amd64}"
  printf "\n\033[1m[%s]\033[0m %s (%s)\n" "$label" "$image" "$platform"

  if docker run --rm --platform="$platform" \
    -v "$PREBUILDS:/app/prebuilds:ro" \
    "$image" node -e "$TEST_SCRIPT" 2>&1; then
    pass=$((pass + 1))
  else
    echo "  FAIL"
    fail=$((fail + 1))
  fi
}

echo "=== zigpty cross-platform tests ==="
echo "prebuilds:"
ls -1 "$PREBUILDS"/*.node 2>/dev/null | while read -r f; do
  echo "  $(basename "$f") ($(du -h "$f" | cut -f1))"
done

# x64 glibc
run_test "x64-glibc" "node:24-slim" "linux/amd64"

# x64 musl (Alpine)
run_test "x64-musl" "node:24-alpine" "linux/amd64"

# arm64 tests — require QEMU or native arm64
if docker run --rm --platform=linux/arm64 node:24-alpine uname -m >/dev/null 2>&1; then
  run_test "arm64-glibc" "node:24-slim" "linux/arm64"
  run_test "arm64-musl" "node:24-alpine" "linux/arm64"
else
  echo ""
  echo "[arm64-glibc] SKIP (no arm64 emulation available)"
  echo "[arm64-musl]  SKIP (no arm64 emulation available)"
  skip=$((skip + 2))
fi

echo ""
echo "=== Results: $pass passed, $fail failed, $skip skipped ==="
[ "$fail" -eq 0 ] || exit 1
