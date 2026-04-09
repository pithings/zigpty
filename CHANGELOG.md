# Changelog

## v0.1.3

[compare changes](https://github.com/pithings/zigpty/compare/v0.1.2...v0.1.3)

### 🩹 Fixes

- **linux:** Preserve SIGSYS handler for Android seccomp softfail ([623be5b](https://github.com/pithings/zigpty/commit/623be5b))

### 🏡 Chore

- Use vitest for release ([c39b950](https://github.com/pithings/zigpty/commit/c39b950))

### 🤖 CI

- Fix flaky test ([483d969](https://github.com/pithings/zigpty/commit/483d969))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.2

[compare changes](https://github.com/pithings/zigpty/compare/v0.1.1...v0.1.2)

### 🩹 Fixes

- **linux:** Use libc `_exit()` instead of raw `exit_group` syscall ([4af46c0](https://github.com/pithings/zigpty/commit/4af46c0))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.1

[compare changes](https://github.com/pithings/zigpty/compare/v0.1.0...v0.1.1)

### 🚀 Enhancements

- **linux:** Add execve linker fallback for Android/Termux noexec mounts ([4febf60](https://github.com/pithings/zigpty/commit/4febf60))

### 🏡 Chore

- Update release script ([52d39a8](https://github.com/pithings/zigpty/commit/52d39a8))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.0

[compare changes](https://github.com/pithings/zigpty/compare/v0.0.7...v0.1.0)

### 🤖 CI

- Setup trusted publishing ([b805187](https://github.com/pithings/zigpty/commit/b805187))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.0.7

[compare changes](https://github.com/pithings/zigpty/compare/v0.0.6...v0.0.7)

### 🚀 Enhancements

- Support pipe fallback ([c773fdd](https://github.com/pithings/zigpty/commit/c773fdd))
- Add Android/Bionic errno compatibility shim ([d17de76](https://github.com/pithings/zigpty/commit/d17de76))
- **pipe:** Auto-detect interactive shells and enable `-i` mode ([b5893ae](https://github.com/pithings/zigpty/commit/b5893ae))

### 🩹 Fixes

- Pipepty improvements ([ab7bfa1](https://github.com/pithings/zigpty/commit/ab7bfa1))
- **test:** Make pipe tests robust on CI ([adc25f0](https://github.com/pithings/zigpty/commit/adc25f0))

### ✅ Tests

- Increase timeout ([f4931e0](https://github.com/pithings/zigpty/commit/f4931e0))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.0.6

[compare changes](https://github.com/pithings/zigpty/compare/v0.0.5...v0.0.6)

### 🔥 Performance

- Fix macOS spawn latency (~120ms → ~12ms) ([#1](https://github.com/pithings/zigpty/pull/1))

### ❤️ Contributors

- Nico Bailon <nico.bailon@gmail.com>

## v0.0.5

[compare changes](https://github.com/pithings/zigpty/compare/v0.0.4...v0.0.5)

### 🚀 Enhancements

- **napi:** Support android platform ([99d77bf](https://github.com/pithings/zigpty/commit/99d77bf))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.0.4

[compare changes](https://github.com/pithings/zigpty/compare/v0.0.3...v0.0.4)

### 🩹 Fixes

- Various fixes ([433b4e1](https://github.com/pithings/zigpty/commit/433b4e1))
- Various js fixes ([67576da](https://github.com/pithings/zigpty/commit/67576da))
- Various fixes ([57bd1ef](https://github.com/pithings/zigpty/commit/57bd1ef))

### 💅 Refactors

- Move node to src/ ([cf3ea75](https://github.com/pithings/zigpty/commit/cf3ea75))
- Update zig structure ([88dbe54](https://github.com/pithings/zigpty/commit/88dbe54))

### 🏡 Chore

- Update example ([b0db7be](https://github.com/pithings/zigpty/commit/b0db7be))
- Update tests ([b3d77b1](https://github.com/pithings/zigpty/commit/b3d77b1))
- Use vitest ([ca4e123](https://github.com/pithings/zigpty/commit/ca4e123))

### 🤖 CI

- Skip bun tests for now ([2ac0d14](https://github.com/pithings/zigpty/commit/2ac0d14))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.0.3

### 🏡 Chore

- Skip unix pty teests on window ([c13b8d8](https://github.com/pithings/zigpty/commit/c13b8d8))

### ✅ Tests

- Increase coverage ([0d67c2c](https://github.com/pithings/zigpty/commit/0d67c2c))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.0.2

[compare changes](https://github.com/pithings/zigpty/compare/v0.0.1...v0.0.2)

### 📦 Build

- Update release script ([f203aae](https://github.com/pithings/zigpty/commit/f203aae))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.0.1

### 🚀 Enhancements

- Add macOS support ([e4c3a18](https://github.com/pithings/zigpty/commit/e4c3a18))

### 🏡 Chore

- Update ci ([e12391c](https://github.com/pithings/zigpty/commit/e12391c))
- Update ci ([27e0272](https://github.com/pithings/zigpty/commit/27e0272))
- Switch to oxfmt formatter with editorconfig ([60d909b](https://github.com/pithings/zigpty/commit/60d909b))
- Apply oxfmt formatting, update docs and ci ([fd3139e](https://github.com/pithings/zigpty/commit/fd3139e))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))
