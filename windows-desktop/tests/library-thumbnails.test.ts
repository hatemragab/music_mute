import { describe, expect, it } from "vitest";
import { thumbnailMime } from "../src/main/library/thumbnails.js";
const jpeg = (width: number, height: number) =>
  Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >>> 8,
    height & 255,
    width >>> 8,
    width & 255,
    1,
    1,
    0x11,
    0,
    0xff,
    0xd9,
  ]);
describe("Library thumbnail bounded raster fixtures", () => {
  it("accepts dimension-bounded JPEG and WebP headers", () => {
    expect(thumbnailMime(jpeg(100, 100))).toBe("image/jpeg");
    const bytes = Buffer.alloc(30);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(22, 4);
    bytes.write("WEBP", 8);
    bytes.write("VP8X", 12);
    bytes.writeUInt32LE(10, 16);
    bytes.writeUIntLE(99, 24, 3);
    bytes.writeUIntLE(99, 27, 3);
    expect(thumbnailMime(bytes)).toBe("image/webp");
  });
  it("rejects SVG/HTML, oversized images, corrupt chunks and dimensions", () => {
    expect(() =>
      thumbnailMime(Buffer.from("<svg><script>alert(1)</script></svg>")),
    ).toThrow("THUMBNAIL_INVALID");
    expect(() => thumbnailMime(Buffer.alloc(1024 * 1024 + 1))).toThrow(
      "THUMBNAIL_INVALID",
    );
    expect(() => thumbnailMime(jpeg(65535, 100))).toThrow("THUMBNAIL_INVALID");
    expect(() => thumbnailMime(Buffer.from("RIFFxxxxWEBPVP8X"))).toThrow(
      "THUMBNAIL_INVALID",
    );
  });
});
