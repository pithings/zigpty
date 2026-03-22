import type { IDisposable, IEvent, IPty, IPtyOptions } from "./types.ts";
import { Terminal } from "../terminal.ts";
import type { TerminalOptions } from "../terminal.ts";

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

export abstract class BasePty implements IPty {
  pid!: number;
  cols: number;
  rows: number;
  handleFlowControl: boolean;

  protected _dataListeners: Array<(data: string | Buffer) => void> = [];
  protected _exitListeners: Array<(info: { exitCode: number; signal: number }) => void> = [];
  protected _closed = false;
  protected _exitCode: number | null = null;
  protected _resolveExited!: (code: number) => void;
  protected _exited: Promise<number>;
  protected _terminal?: Terminal;
  protected _onExitCallback?: (exitCode: number, signal: number) => void;

  constructor(cols: number, rows: number, options?: IPtyOptions) {
    this.cols = cols;
    this.rows = rows;
    this.handleFlowControl = options?.handleFlowControl ?? false;
    this._onExitCallback = options?.onExit;

    this._exited = new Promise<number>((resolve) => {
      this._resolveExited = resolve;
    });

    if (options?.terminal) {
      this._terminal =
        options.terminal instanceof Terminal
          ? options.terminal
          : new Terminal(options.terminal as TerminalOptions);
    }
  }

  get exited(): Promise<number> {
    return this._exited;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get onData(): IEvent<string | Buffer> {
    return (listener): IDisposable => {
      this._dataListeners.push(listener);
      return {
        dispose: () => {
          const idx = this._dataListeners.indexOf(listener);
          if (idx >= 0) this._dataListeners.splice(idx, 1);
        },
      };
    };
  }

  get onExit(): IEvent<{ exitCode: number; signal: number }> {
    return (listener): IDisposable => {
      this._exitListeners.push(listener);
      return {
        dispose: () => {
          const idx = this._exitListeners.indexOf(listener);
          if (idx >= 0) this._exitListeners.splice(idx, 1);
        },
      };
    };
  }

  waitFor(pattern: string, options?: { timeout?: number }): Promise<string> {
    const timeout = options?.timeout ?? 30_000;
    const terminal = this._terminal;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const pty = this;
    return new Promise((resolve, reject) => {
      let collected = "";
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`waitFor("${pattern}") timed out after ${timeout}ms`));
      }, timeout);

      let disposable: { dispose(): void } | undefined;
      let terminalListener: ((data: string) => void) | undefined;

      const onChunk = (text: string) => {
        collected += text;
        if (collected.includes(pattern)) {
          cleanup();
          resolve(collected);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        disposable?.dispose();
        if (terminalListener && terminal) {
          const idx = terminal._dataListeners.indexOf(terminalListener);
          if (idx >= 0) terminal._dataListeners.splice(idx, 1);
        }
      };

      if (terminal) {
        terminalListener = onChunk;
        terminal._dataListeners.push(terminalListener);
      }

      disposable = pty.onData((data) => {
        onChunk(typeof data === "string" ? data : data.toString());
      });
    });
  }

  protected _handleExit(info: { exitCode: number; signal: number }): void {
    this._closed = true;
    this._exitCode = info.exitCode;
    this._onExitCallback?.(info.exitCode, info.signal);
    for (const listener of this._exitListeners) {
      listener(info);
    }
    this._resolveExited(info.exitCode);
  }

  abstract get process(): string;
  abstract write(data: string): void;
  abstract resize(cols: number, rows: number, pixelSize?: { width: number; height: number }): void;
  abstract clear(): void;
  abstract kill(signal?: string): void;
  abstract pause(): void;
  abstract resume(): void;
  abstract close(): void;
}

export function buildEnvPairs(env: Record<string, string | undefined>, termName?: string, sanitizeKeys?: string[]): string[] {
  const pairs: string[] = [];
  const envCopy = { ...env };

  if (termName && !envCopy.TERM) {
    envCopy.TERM = termName;
  }

  if (sanitizeKeys) {
    for (const key of sanitizeKeys) {
      delete envCopy[key];
    }
  }

  for (const [key, value] of Object.entries(envCopy)) {
    if (value !== undefined) {
      pairs.push(`${key}=${value}`);
    }
  }
  return pairs;
}
