export const MAX_BROWSER_FRAME = 65536;
export function encodeBrowserFrame(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length < 2 || bytes.length > MAX_BROWSER_FRAME)
    throw new Error("FRAME_INVALID");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}
export class BrowserFrameDecoder {
  private pending = Buffer.alloc(0);
  push(chunk: Uint8Array): unknown[] {
    if (
      chunk.byteLength > MAX_BROWSER_FRAME * 2 + 8 ||
      this.pending.length + chunk.byteLength > MAX_BROWSER_FRAME * 3 + 12
    )
      throw new Error("FRAME_INVALID");
    this.pending = Buffer.concat([this.pending, chunk]);
    const values: unknown[] = [];
    while (this.pending.length >= 4) {
      const count = this.pending.readUInt32LE(0);
      if (count < 2 || count > MAX_BROWSER_FRAME)
        throw new Error("FRAME_INVALID");
      if (this.pending.length < count + 4) break;
      try {
        values.push(
          parseStrictJson(
            new TextDecoder("utf-8", { fatal: true }).decode(
              this.pending.subarray(4, count + 4),
            ),
          ),
        );
      } catch {
        throw new Error("FRAME_INVALID");
      }
      this.pending = this.pending.subarray(count + 4);
    }
    return values;
  }
  finish(): void {
    if (this.pending.length) throw new Error("FRAME_TRUNCATED");
  }
}
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
