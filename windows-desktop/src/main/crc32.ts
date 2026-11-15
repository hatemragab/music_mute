const table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
export const CRC32_INITIAL = 0xffffffff;
export function updateCrc32(state: number, bytes: Uint8Array): number {
  for (const byte of bytes)
    state = (state >>> 8) ^ table[(state ^ byte) & 0xff]!;
  return state >>> 0;
}
export const finishCrc32 = (state: number): number =>
  (state ^ 0xffffffff) >>> 0;
export const crc32 = (bytes: Uint8Array): number =>
  finishCrc32(updateCrc32(CRC32_INITIAL, bytes));
