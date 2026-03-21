import { isWindows, native, type INativeUnix, type INativeWindows } from "./napi.ts";
import type { IOpenResult, IPty, IPtyOpenOptions, IPtyOptions } from "./types.ts";
import { UnixTerminal } from "./unix.ts";
import { WindowsTerminal } from "./windows.ts";

export type {
  IDisposable,
  IEvent,
  IOpenResult,
  IPty,
  IPtyOpenOptions,
  IPtyOptions,
} from "./types.ts";

export { Terminal, type TerminalOptions } from "./terminal.ts";

export function spawn(file?: string, args: string[] = [], options?: IPtyOptions): IPty {
  const shell = file ?? defaultShell();
  if (isWindows) {
    return new WindowsTerminal(native as INativeWindows, shell, args, options);
  }
  return new UnixTerminal(shell, args, options);
}

function defaultShell(): string {
  if (isWindows) {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/sh";
}

export function open(options?: IPtyOpenOptions): IOpenResult {
  if (isWindows) {
    throw new Error("open() is not supported on Windows");
  }
  return (native as INativeUnix).open(options?.cols ?? 80, options?.rows ?? 24);
}
