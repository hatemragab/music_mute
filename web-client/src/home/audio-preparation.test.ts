import { expect, test } from "vitest";
import { classifyAudio } from "./audio-preparation";

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
