import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { STORE_ASSET_DIMENSIONS } from "./manifest.js";

export const STORE_ICON_SOURCE = Object.freeze({
  path: "chrome-extension/src/extension/static/icons/icon-128.png",
  bytes: 2081,
  sha256: "1ba172ee149c89a7e67c636f9a99c42636fc557ed2cb8828e8b528e16ced04d2",
});
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function invalid(): never {
  throw new Error("STORE_ASSET_INVALID");
}
export function decodeStoreAssetPng(value: Uint8Array) {
  const bytes = Buffer.from(value);
  if (
    bytes.length < 45 ||
    bytes.length > 1024 ** 2 ||
    !bytes.subarray(0, 8).equals(SIGNATURE)
  )
    invalid();
  let at = 8,
    width = 0,
    height = 0,
    ended = false;
  const data: Buffer[] = [];
  while (at < bytes.length) {
    if (at + 12 > bytes.length) invalid();
    const length = bytes.readUInt32BE(at);
    if (length > 1024 ** 2 || at + length + 12 > bytes.length) invalid();
    const kind = bytes.toString("ascii", at + 4, at + 8);
    const payload = bytes.subarray(at + 8, at + 8 + length);
    if (
      crc32(bytes.subarray(at + 4, at + 8 + length)) !==
      bytes.readUInt32BE(at + 8 + length)
    )
      invalid();
    if (kind === "IHDR") {
      if (
        at !== 8 ||
        length !== 13 ||
        width ||
        payload[8] !== 8 ||
        payload[9] !== 6 ||
        payload[10] !== 0 ||
        payload[11] !== 0 ||
        payload[12] !== 0
      )
        invalid();
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      if (width < 1 || height < 1 || width > 512 || height > 512) invalid();
    } else if (kind === "IDAT") {
      if (!width || ended) invalid();
      data.push(payload);
    } else if (kind === "IEND") {
      if (length !== 0 || !data.length || at + 12 !== bytes.length) invalid();
      ended = true;
    } else if (kind[0] === kind[0]?.toUpperCase()) invalid();
    at += length + 12;
  }
  if (!ended || !data.length) invalid();
  const stride = width * 4;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(data), {
      maxOutputLength: (stride + 1) * height,
    });
  } catch {
    return invalid();
  }
  if (raw.length !== (stride + 1) * height) invalid();
  const rgba = Buffer.alloc(stride * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c,
      da = Math.abs(p - a),
      db = Math.abs(p - b),
      dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    if (filter > 4) invalid();
    for (let x = 0; x < stride; x++) {
      const offset = y * stride + x;
      const left = x >= 4 ? rgba[offset - 4]! : 0,
        up = y ? rgba[offset - stride]! : 0,
        upperLeft = y && x >= 4 ? rgba[offset - stride - 4]! : 0;
      const correction = [
        0,
        left,
        up,
        Math.floor((left + up) / 2),
        paeth(left, up, upperLeft),
      ][filter]!;
      rgba[offset] = (raw[y * (stride + 1) + x + 1]! + correction) & 255;
    }
  }
  return { width, height, rgba };
}
function chunk(kind: string, bytes: Buffer) {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  result.write(kind, 4, "ascii");
  bytes.copy(result, 8);
  result.writeUInt32BE(
    crc32(result.subarray(4, result.length - 4)),
    result.length - 4,
  );
  return result;
}
function encode(width: number, height: number, rgba: Buffer) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scan = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    rgba.copy(
      scan,
      y * (width * 4 + 1) + 1,
      y * width * 4,
      (y + 1) * width * 4,
    );
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scan, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function scale(
  source: ReturnType<typeof decodeStoreAssetPng>,
  width: number,
  height: number,
) {
  const rgba = Buffer.alloc(width * height * 4);
  const edge = Math.min(width, height),
    left = Math.floor((width - edge) / 2),
    top = Math.floor((height - edge) / 2);
  for (let y = 0; y < edge; y++)
    for (let x = 0; x < edge; x++) {
      const sx = Math.max(
        0,
        Math.min(source.width - 1, ((x + 0.5) * source.width) / edge - 0.5),
      );
      const sy = Math.max(
        0,
        Math.min(source.height - 1, ((y + 0.5) * source.height) / edge - 0.5),
      );
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        dx = sx - x0,
        dy = sy - y0;
      const samples = [
        [x0, y0, (1 - dx) * (1 - dy)],
        [Math.min(x0 + 1, source.width - 1), y0, dx * (1 - dy)],
        [x0, Math.min(y0 + 1, source.height - 1), (1 - dx) * dy],
        [
          Math.min(x0 + 1, source.width - 1),
          Math.min(y0 + 1, source.height - 1),
          dx * dy,
        ],
      ];
      let alpha = 0;
      const rgb = [0, 0, 0];
      for (const [xx, yy, weight] of samples) {
        const offset = (yy! * source.width + xx!) * 4,
          a = (source.rgba[offset + 3]! / 255) * weight!;
        alpha += a;
        for (let c = 0; c < 3; c++)
          rgb[c] = rgb[c]! + source.rgba[offset + c]! * a;
      }
      const out = ((y + top) * width + x + left) * 4;
      for (let c = 0; c < 3; c++)
        rgba[out + c] = alpha ? Math.round(rgb[c]! / alpha) : 0;
      rgba[out + 3] = Math.round(alpha * 255);
    }
  return encode(width, height, rgba);
}
export function buildStoreAssets(source: Uint8Array) {
  const bytes = Buffer.from(source);
  if (
    bytes.length !== STORE_ICON_SOURCE.bytes ||
    createHash("sha256").update(bytes).digest("hex") !==
      STORE_ICON_SOURCE.sha256
  )
    invalid();
  const image = decodeStoreAssetPng(bytes);
  return Object.fromEntries(
    Object.entries(STORE_ASSET_DIMENSIONS).map(([name, [width, height]]) => [
      name,
      scale(image, width, height),
    ]),
  ) as Record<keyof typeof STORE_ASSET_DIMENSIONS, Buffer>;
}
export function buildStoreIcon(source: Uint8Array) {
  buildStoreAssets(source); // Same approved source/CRC/RGBA validation as tiles.
  // Electron's Windows resource editor requires a 256px ICO entry. Keep the
  // exact reviewed mark and existing transparent bilinear scaling; ICO encodes
  // a 256px width/height as zero, while the embedded PNG carries its real size.
  const bytes = scale(decodeStoreAssetPng(source), 256, 256),
    header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(bytes.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, bytes]);
}
export async function stageStoreAssets(
  source: Uint8Array,
  newAssetRoot: string,
) {
  const assets = buildStoreAssets(source);
  await mkdir(newAssetRoot);
  for (const [name, bytes] of Object.entries(assets))
    await writeFile(join(newAssetRoot, name), bytes, { flag: "wx" });
  return Object.entries(assets).map(([path, bytes]) => ({
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
}
