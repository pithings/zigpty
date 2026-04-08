import { isWindows, hasNative, native, type INativeUnix, type INativeWindows } from "./napi.ts";
import type { IOpenResult, IPty, IPtyOpenOptions, IPtyOptions } from "./pty/types.ts";
import { UnixPty } from "./pty/unix.ts";
import { WindowsPty } from "./pty/windows.ts";
import { PipePty } from "./pty/pipe.ts";

export type {
  IDisposable,
  IEvent,
  IOpenResult,
  IPty,
  IPtyOpenOptions,
  IPtyOptions,
} from "./pty/types.ts";

export { Terminal, type TerminalOptions } from "./terminal.ts";
export { PipePty } from "./pty/pipe.ts";

/** True when native Zig PTY bindings are available. When false, spawn() uses a pipe-based fallback. */
export { hasNative } from "./napi.ts";

export function spawn(file?: string, args: string[] = [], options?: IPtyOptions): IPty {
  const shell = file ?? defaultShell();

  // Fallback: no native bindings or explicit pipe mode → pipe-based PTY
  if (!hasNative || options?.pipe) {
    return new PipePty(shell, args, options);
  }

  if (isWindows) {
    return new WindowsPty(native as INativeWindows, shell, args, options);
  }
  return new UnixPty(shell, args, options);
}

function defaultShell(): string {
  if (isWindows) {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/sh";
}

export function open(options?: IPtyOpenOptions): IOpenResult {
  if (!hasNative) {
    throw new Error("open() requires native PTY bindings (not available in pipe fallback mode)");
  }
  if (isWindows) {
    throw new Error("open() is not supported on Windows");
  }
  return (native as INativeUnix).open(options?.cols ?? 80, options?.rows ?? 24);
}
