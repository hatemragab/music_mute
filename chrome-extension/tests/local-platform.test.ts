import { describe, expect, it } from "vitest";
import {
  desktopInputPathIsSafe,
  localPlatform,
  safeWindowsAbsolutePath,
  windowsLocalPaths,
} from "../src/shared/local-platform.js";
import { parseDesktopRequest } from "../src/shared/desktop-protocol.js";
describe("explicit local platform policy", () => {
  it("distinguishes GPU, private transport and profile without enabling provider availability", () => {
    expect(
      localPlatform({
        platform: "win32",
        architecture: "x64",
        nativeArchitecture: "x64",
        osBuild: 19045,
      }),
    ).toMatchObject({
      provider: "directml",
      providerId: "LOCAL_WINDOWS",
      runtimeProfile: "windows-user",
      privateTransport: "named-pipe",
    });
    expect(
      localPlatform({
        platform: "darwin",
        architecture: "arm64",
        nativeArchitecture: "arm64",
      }),
    ).toMatchObject({ provider: "mps", providerId: "LOCAL_MACOS" });
    expect(() =>
      localPlatform({
        platform: "win32",
        architecture: "x64",
        nativeArchitecture: "arm64",
        osBuild: 26100,
      }),
    ).toThrow("UNSUPPORTED_PLATFORM");
    expect(() =>
      localPlatform({
        platform: "win32",
        architecture: "x64",
        nativeArchitecture: "x64",
        osBuild: 19044,
      }),
    ).toThrow("UNSUPPORTED_PLATFORM");
  });
  it.each([
    "C:\\Users\\Example\\Audio\\صوت.mp3",
    "D:/Audio/my recording.wav",
    "C:\\",
  ])("accepts a local drive path %s", (value) =>
    expect(safeWindowsAbsolutePath(value)).toBe(true),
  );
  it.each([
    "C:relative.mp3",
    "\\\\server\\share\\file.wav",
    "\\\\?\\C:\\file.wav",
    "C:\\audio\\..\\file.wav",
    "C:\\audio\\CON.mp3",
    "C:\\audio\\LPT1",
    "C:\\audio\\file.wav:secret",
    "C:\\audio\\file. ",
    "C:\\audio\\nul.txt",
    "C:\\audio\\a\u0000.wav",
    "C:\\audio\\file?.wav",
  ])("rejects an ambiguous input path %s", (value) =>
    expect(safeWindowsAbsolutePath(value)).toBe(false),
  );
  it("resolves Windows roots on a Mac with no host-dependent separators", () => {
    const paths = windowsLocalPaths("C:\\Users\\Example\\AppData\\Local");
    expect(paths.root).toBe(
      "C:\\Users\\Example\\AppData\\Local\\MusicMuteLocal",
    );
    expect(paths.workerRoot).toBe(
      "C:\\Users\\Example\\AppData\\Local\\MusicMuteWorker",
    );
    expect(paths.chromeManifest).toMatch(/com\.musicmute\.local\.json$/);
  });
  it("keeps the current POSIX desktop path policy", () => {
    expect(desktopInputPathIsSafe("/tmp/input.wav", "darwin")).toBe(true);
    expect(desktopInputPathIsSafe("C:\\audio.wav", "darwin")).toBe(false);
  });
  it("parses Windows desktop file requests through an explicit trusted adapter", () => {
    const request = {
      protocol_version: 1,
      request_id: "b9c0a3bb-846f-4c11-8077-a27eac979c98",
      type: "LOCAL_START",
      payload: { source_kind: "file", source_path: "C:\\Audio\\recording.wav" },
    };
    expect(
      parseDesktopRequest(JSON.stringify(request), { platform: "win32" }),
    ).toEqual(request);
    expect(() =>
      parseDesktopRequest(JSON.stringify(request), { platform: "darwin" }),
    ).toThrow();
    expect(() =>
      parseDesktopRequest(
        JSON.stringify({
          ...request,
          payload: { source_kind: "file", source_path: "C:\\CON.wav" },
        }),
        { platform: "win32" },
      ),
    ).toThrow();
  });
});
