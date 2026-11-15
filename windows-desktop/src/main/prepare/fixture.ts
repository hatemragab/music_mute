import { createHash } from "node:crypto";

/** Synthetic PCM speech harmonics; source-owned, deterministic, and free of user media. */
export function preparationFixture(): Buffer {
  const rate = 44100,
    frames = rate * 6;
  const bytes = Buffer.alloc(44 + frames * 4);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 4, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 4, 40);
  for (let frame = 0; frame < frames; frame++) {
    const triangle = (period: number): number => {
      const phase = frame % period;
      return phase < period / 2 ? phase * 4 - period : period * 3 - phase * 4;
    };
    const envelope = 50 + Math.floor(((frame % 17640) * 50) / 17640);
    const sample = Math.trunc(
      ((triangle(400) * 16 + triangle(200) * 8 + triangle(80) * 3) * envelope) /
        100,
    );
    bytes.writeInt16LE(sample, 44 + frame * 4);
    bytes.writeInt16LE(sample, 46 + frame * 4);
  }
  return bytes;
}
const material = preparationFixture();
/** The signed application owns this qualification pin, independent of account/fleet grants. */
export const PREPARATION_FIXTURE = Object.freeze({
  filename: "prepare-fixture.wav",
  bytes: material.length,
  sha256: createHash("sha256").update(material).digest("hex"),
});
