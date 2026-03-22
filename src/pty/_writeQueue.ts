import * as fs from "node:fs";

export class WriteQueue {
  private _queue: Array<{ buffer: Buffer; offset: number }> = [];
  private _writing = false;
  private _immediate: ReturnType<typeof setImmediate> | null = null;
  private _closed = false;
  private _fd: number;
  private _onDrain?: () => void;

  constructor(fd: number, onDrain?: () => void) {
    this._fd = fd;
    this._onDrain = onDrain;
  }

  enqueue(data: string | Uint8Array, encoding?: BufferEncoding | null): number {
    if (this._closed || this._fd < 0) return 0;
    const buf = typeof data === "string"
      ? Buffer.from(data, encoding || "utf8")
      : Buffer.from(data);
    this._queue.push({ buffer: buf, offset: 0 });
    this._process();
    return buf.length;
  }

  close(): void {
    this._closed = true;
    if (this._immediate) {
      clearImmediate(this._immediate);
      this._immediate = null;
    }
    this._queue.length = 0;
  }

  private _process(): void {
    if (this._writing || this._queue.length === 0 || this._closed) return;
    this._writing = true;

    const task = this._queue[0]!;
    fs.write(this._fd, task.buffer, task.offset, (err, written) => {
      this._writing = false;
      if (this._closed) return;

      if (err) {
        if ("code" in err && err.code === "EAGAIN") {
          this._immediate = setImmediate(() => this._process());
          return;
        }
        this._queue.length = 0;
        return;
      }

      task.offset += written;
      if (task.offset >= task.buffer.length) {
        this._queue.shift();
      }

      if (this._queue.length === 0) {
        this._onDrain?.();
      }

      this._process();
    });
  }
}
