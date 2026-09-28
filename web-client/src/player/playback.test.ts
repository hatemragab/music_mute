import { expect, test } from "vitest";
import {
  chooseNextIndex,
  hasNextTrack,
  passageLoop,
  trackTitle,
} from "./playback";

const unnamed = {
  id: "6abaade2a3f12dc9ed43c129",
  displayName: null,
  sourceTitle: null,
};

test("track titles never fall back to a raw id", () => {
  expect(trackTitle(unnamed, "Untitled track")).toBe("Untitled track");
  expect(
    trackTitle(
      { ...unnamed, displayName: "6abaade2a3f12dc9ed43c129" },
      "Untitled track",
    ),
  ).toBe("Untitled track");
  expect(
    trackTitle(
      { ...unnamed, sourceTitle: "  Evening melody  " },
      "Untitled track",
    ),
  ).toBe("Evening melody");
});

test("next follows the queue, wraps only for repeat-all, and shuffle skips the current row", () => {
  expect(chooseNextIndex(3, 0, "off", false)).toBe(1);
  expect(chooseNextIndex(3, 2, "off", false)).toBe(-1);
  expect(chooseNextIndex(3, 2, "all", false)).toBe(0);
  expect(chooseNextIndex(1, 0, "off", true)).toBe(-1);
  expect(chooseNextIndex(1, 0, "one", true)).toBe(0);
  expect(chooseNextIndex(4, 1, "off", true, () => 0)).toBe(0);
  expect(chooseNextIndex(4, 1, "off", true, () => 0.99)).toBe(3);
  expect(hasNextTrack(3, 2, "off", false)).toBe(false);
  expect(hasNextTrack(3, 2, "all", false)).toBe(true);
  expect(hasNextTrack(2, 1, "off", true)).toBe(true);
  expect(hasNextTrack(0, -1, "all", true)).toBe(false);
});

test("passage loop is fifteen seconds from the playhead and stays inside the track", () => {
  expect(passageLoop(10, 100)).toEqual({ start: 10, end: 25 });
  expect(passageLoop(95, 100)).toEqual({ start: 85, end: 100 });
  expect(passageLoop(1, 8)).toEqual({ start: 0, end: 8 });
  expect(passageLoop(0, 0)).toBeNull();
});
