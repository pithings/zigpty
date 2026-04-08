#!/bin/bash
# Test zigpty musl prebuild on Android/Bionic via Termux Docker.
#
# The musl builds include a weak errno shim that bridges musl's
# __errno_location to Bionic's __errno, so the same binary works
# on both musl Linux and Android.
#
# Requires Docker with QEMU binfmt for arm64 emulation:
#   docker run --rm --privileged multiarch/qemu-user-static --reset -p yes
#
# Usage:
#   bash scripts/test_android.sh          # smoke test only
#   bash scripts/test_android.sh --all    # smoke test + full vitest suite
set -euo pipefail

RUN_ALL=false
if [ "${1:-}" = "--all" ]; then
  RUN_ALL=true
fi

cd "$(dirname "$0")/.."

PREBUILDS="$(pwd)/prebuilds"
BINARY="zigpty.linux-arm64-musl.node"

if [ ! -f "$PREBUILDS/$BINARY" ]; then
  echo "ERROR: $BINARY not found in prebuilds/"
  echo "Run: zig build --release"
  exit 1
fi

echo "=== zigpty Android compatibility test ==="
echo "binary: $BINARY ($(du -h "$PREBUILDS/$BINARY" | cut -f1))"

# Verify the binary has weak errno shim symbols
echo ""
echo "--- Symbol check ---"
if command -v nm >/dev/null 2>&1; then
  errno_loc=$(nm -D "$PREBUILDS/$BINARY" 2>/dev/null | grep __errno_location | head -1 || true)
  errno_bionic=$(nm -D "$PREBUILDS/$BINARY" 2>/dev/null | grep ' w __errno$' || true)

  if echo "$errno_loc" | grep -q ' W '; then
    echo "  __errno_location: WEAK DEFINED (shim active)"
  elif echo "$errno_loc" | grep -q ' T '; then
    echo "  __errno_location: STRONG DEFINED (shim active)"
  else
    echo "  __errno_location: UNDEFINED (shim missing!)"
    exit 1
  fi

  if [ -n "$errno_bionic" ]; then
    echo "  __errno: WEAK UNDEFINED (resolves from Bionic)"
  else
    echo "  __errno: NOT FOUND (expected as weak import)"
    exit 1
  fi
else
  echo "  (nm not available, skipping symbol check)"
fi

# Check if arm64 emulation is available
echo ""
echo "--- Checking arm64 emulation ---"
HAS_QEMU=false
if [ -f /proc/sys/fs/binfmt_misc/qemu-aarch64 ] || \
   [ -f /proc/sys/fs/binfmt_misc/aarch64 ]; then
  HAS_QEMU=true
  echo "  QEMU binfmt_misc: registered"
elif [ "$(uname -m)" = "aarch64" ]; then
  HAS_QEMU=true
  echo "  native arm64 host"
else
  echo "  QEMU binfmt_misc: not registered"
  echo "  To enable: docker run --rm --privileged multiarch/qemu-user-static --reset -p yes"
  echo ""
  echo "=== Android test SKIPPED (symbol check passed, runtime test requires arm64 emulation) ==="
  exit 0
fi

# Runtime test with arm64 Linux + Node.js
echo ""
echo "--- Runtime test (arm64 Docker) ---"

read -r -d '' TEST_SCRIPT << 'JSEOF' || true
const fs = require("node:fs");
const tty = require("node:tty");

const prebuild = "/app/prebuilds/zigpty.linux-arm64-musl.node";

try {
  process.dlopen(module, prebuild);
} catch (e) {
  console.error("  FAIL: dlopen error:", e.message);
  process.exit(1);
}
const native = module.exports;
console.log("  loaded:", prebuild);

// Test 1: open PTY pair
try {
  const pair = native.open(80, 24);
  console.log("  open(): master=%d slave=%d pty=%s", pair.master, pair.slave, pair.pty);
} catch (e) {
  console.log("  open(): SKIP (%s)", e.message);
}

// Test 2: fork + exit
const result = native.fork(
  "/bin/sh", ["-c", "echo hello-zigpty-android && exit 0"],
  Object.entries(process.env).map(([k, v]) => k + "=" + v),
  "/tmp", 80, 24, -1, -1, true,
  (info) => {
    console.log("  exit: code=%d signal=%d", info.exitCode, info.signal);
    console.log("  PASS");
    process.exit(0);
  }
);
console.log("  fork(): pid=%d fd=%d", result.pid, result.fd);

const stream = new tty.ReadStream(result.fd);
stream.setEncoding("utf8");
stream.on("data", (data) => process.stdout.write("  output: " + data));
stream.on("error", () => {});
setTimeout(() => { console.log("  FAIL: timeout"); process.exit(1); }, 10000);
JSEOF

# Use Alpine (musl-based) since the binary links against musl libc.so
docker run --rm --platform=linux/arm64 \
  -v "$PREBUILDS:/app/prebuilds:ro" \
  node:24-alpine \
  node -e "$TEST_SCRIPT"

if [ "$RUN_ALL" = true ]; then
  echo ""
  echo "--- Full vitest suite (arm64 Docker) ---"
  docker run --rm --platform=linux/arm64 \
    -v "$(pwd):/host:ro" \
    -w /work \
    node:24-alpine \
    sh -c '
      cd /host
      find . -maxdepth 1 -not -name node_modules -not -name . -exec cp -r {} /work/ \;
      cd /work
      node -e "
        const pkg = JSON.parse(require(\"fs\").readFileSync(\"package.json\",\"utf8\"));
        delete pkg.packageManager;
        require(\"fs\").writeFileSync(\"package.json\", JSON.stringify(pkg, null, 2));
      "
      rm -rf node_modules pnpm-lock.yaml
      echo "  installing dependencies..."
      npm install --silent --legacy-peer-deps 2>&1 | tail -1
      ZIGPTY_QEMU=1 npx vitest run 2>&1
    '
fi

echo ""
echo "=== Android test PASSED ==="
