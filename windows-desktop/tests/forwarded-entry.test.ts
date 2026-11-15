import { expect, it } from "vitest";
import { forwardedDesktopEntryMode } from "../src/main/entry-mode.js";

const resources =
  "C:\\Users\\fixture\\AppData\\Local\\Programs\\MusicMute\\resources";

it("accepts UI forwarding and exact headless acknowledgement without turning hidden modes into UI actions", () => {
  expect(forwardedDesktopEntryMode([], resources)).toBe("ui");
  expect(
    forwardedDesktopEntryMode(
      ["musicmute://cloud?video_id=abcdefghi12"],
      resources,
    ),
  ).toBe("ui");
  expect(forwardedDesktopEntryMode(["--headless-account"], resources)).toBe(
    "headless-account",
  );
  expect(
    forwardedDesktopEntryMode(
      ["--installer-maintenance", "register"],
      resources,
    ),
  ).toBeNull();
  expect(
    forwardedDesktopEntryMode(
      [
        "--native-browser-stdio",
        "--origin",
        "chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/",
        "--resources",
        resources,
      ],
      resources,
    ),
  ).toBeNull();
});

it("safely rejects malformed or mixed hidden forwarding before any public handoff is received", () => {
  for (const args of [
    ["--headless-account", "musicmute://cloud?video_id=abcdefghi12"],
    ["--native-browser-stdio"],
    ["--installer-maintenance", "purge"],
    ["musicmute://cloud?video_id=abcdefghi12", "--headless-account"],
    ["--headless-account", "--installer-maintenance", "install"],
    [
      "--native-browser-stdio",
      "--origin",
      "chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/",
      "--resources",
      "C:\\Other\\resources",
    ],
  ])
    expect(forwardedDesktopEntryMode(args, resources)).toBeNull();
});
