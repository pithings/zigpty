import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { fileURLToPath } from "node:url";

export interface INativeUnix {
  fork(
    file: string,
    args: string[],
    env: string[],
    cwd: string,
    cols: number,
    rows: number,
    uid: number,
    gid: number,
    useUtf8: boolean,
    onExit: (info: { exitCode: number; signal: number }) => void,
  ): { fd: number; pid: number; pty: string };

  open(cols: number, rows: number): { master: number; slave: number; pty: string };

  resize(fd: number, cols: number, rows: number, xPixel?: number, yPixel?: number): void;

  process(fd: number): string | undefined;
}

export interface INativeWindows {
  spawn(
    file: string,
    args: string[],
    env: string[],
    cwd: string,
    cols: number,
    rows: number,
    onData: (data: Buffer) => void,
    onExit: (info: { exitCode: number; signal: number }) => void,
  ): { pid: number; handle: object };

  write(handle: object, data: string): void;

  resize(handle: object, cols: number, rows: number): void;

  kill(handle: object): void;

  close(handle: object): void;
}

export type INative = INativeUnix | INativeWindows;

const isWindows = platform() === "win32";

function loadNative(): INative {
  const require = createRequire(import.meta.url);
  const base = `zigpty.${platform()}-${arch()}`;
  const resolve = (name: string) =>
    fileURLToPath(new URL(`../prebuilds/${name}.node`, import.meta.url));

  if (isWindows) {
    return require(resolve(base)) as INativeWindows;
  }

  // Try glibc build first, fall back to musl (for Alpine/musl-based distros)
  try {
    return require(resolve(base)) as INativeUnix;
  } catch {}
  return require(resolve(`${base}-musl`)) as INativeUnix;
}

export const native: INative = loadNative();
export { isWindows };
