import { expect, test } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { classifyAudio, sha256Base64 } from "./audio-preparation";

test("passes a compatible low-bitrate compressed file through", () => {
  expect(classifyAudio("song.MP3", 1_000_000, 60)).toEqual({
    extension: "mp3",
    convert: false,
  });
});

test("requires conversion when average bitrate exceeds the profile cap", () => {
  expect(classifyAudio("song.mp3", 2_000_000, 60)).toEqual({
    extension: "mp3",
    convert: true,
  });
});

test("requires conversion for a decodable but unsupported container", () => {
  expect(classifyAudio("song.wav", 1_000_000, 60)).toEqual({
    extension: null,
    convert: true,
  });
});

// Fixed SHA-256 vectors exercise encoding independently of the implementation.
test("declares the canonical padded base64 checksum required by API and S3", async () => {
  expect(await sha256Base64(new NodeBlob(["abc"]) as unknown as Blob)).toBe(
    "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
  );
});
