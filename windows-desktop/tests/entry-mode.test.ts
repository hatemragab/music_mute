import { expect, it } from "vitest";
import { desktopEntryMode } from "../src/main/entry-mode.js";
import { STORE_BROWSER_ORIGIN } from "../src/main/browser/store-registration.js";
const resources =
  "C:\\Users\\fixture\\AppData\\Local\\Programs\\MusicMute Local\\resources";
const origin = "chrome-extension://" + "a".repeat(32);
it("requires the closed Store host handoff and preserves its one-use nonce", () => {
  const args = [
    "--native-browser-stdio",
    "--origin",
    STORE_BROWSER_ORIGIN,
    "--resources",
    resources,
    "--store-browser-host",
    "1234",
    "--store-browser-nonce",
    "a".repeat(64),
  ];
  expect(desktopEntryMode(args, resources, true)).toEqual({
    kind: "browser",
    arguments: args.slice(1),
  });
  for (const invalid of [
    args.slice(0, 5),
    [...args, "extra"],
    args.map((value, index) => (index === 6 ? "01234" : value)),
    args.map((value, index) => (index === 6 ? "4294967296" : value)),
    args.map((value, index) => (index === 8 ? "A".repeat(64) : value)),
    args.map((value, index) => (index === 2 ? origin : value)),
  ])
    expect(() => desktopEntryMode(invalid, resources, true)).toThrow(
      "ENTRY_ARGUMENT_INVALID",
    );
  expect(() => desktopEntryMode(args, resources, false)).toThrow(
    "ENTRY_ARGUMENT_INVALID",
  );
  expect(() =>
    desktopEntryMode(["--installer-maintenance", "install"], resources, true),
  ).toThrow("ENTRY_ARGUMENT_INVALID");
  expect(() =>
    desktopEntryMode(["--store-browser-host", "1234"], resources, true),
  ).toThrow("ENTRY_ARGUMENT_INVALID");
});
it("routes exact native modes without requesting UI account ownership", () => {
  expect(desktopEntryMode(["--headless-account"], resources)).toEqual({
    kind: "headless-account",
  });
  for (const action of ["install", "uninstall", "register"] as const)
    expect(
      desktopEntryMode(["--installer-maintenance", action], resources),
    ).toEqual({ kind: "installer", action });
  expect(
    desktopEntryMode(
      ["--native-browser-stdio", "--origin", origin, "--resources", resources],
      resources,
    ),
  ).toEqual({
    kind: "browser",
    arguments: ["--origin", origin, "--resources", resources],
  });
  expect(
    desktopEntryMode(
      ["musicmute-local://cloud?video_id=abcdefghijk"],
      resources,
    ),
  ).toEqual({ kind: "ui" });
});
it("rejects mixed modes, foreign resources, bad origins and arbitrary trailing arguments", () => {
  for (const args of [
    ["--headless-account", "--eval", "secret"],
    [
      "--native-browser-stdio",
      "--origin",
      "https://evil.invalid",
      "--resources",
      resources,
    ],
    [
      "--native-browser-stdio",
      "--origin",
      origin,
      "--resources",
      "C:\\Other\\resources",
    ],
    [
      "--native-browser-stdio",
      "--origin",
      origin,
      "--resources",
      resources,
      "secret",
    ],
    ["--other", "--headless-account"],
    ["--installer-maintenance"],
    ["--installer-maintenance", "run"],
    ["--installer-maintenance", "install", "--headless-account"],
    ["--other", "--installer-maintenance", "uninstall"],
  ])
    expect(() => desktopEntryMode(args, resources)).toThrow(
      "ENTRY_ARGUMENT_INVALID",
    );
});
