import { expect, it } from "vitest";
import {
  windowsLocalConfig,
  type WindowsConfigInput,
} from "../src/companion/windows-config.js";
const input: WindowsConfigInput = {
  host: {
    platform: "win32",
    architecture: "x64",
    nativeArchitecture: "x64",
    osBuild: 19045,
  },
  localAppData: "C:\\Users\\Example\\AppData\\Local",
  appResources:
    "C:\\Users\\Example\\AppData\\Local\\Programs\\MusicMute Local\\resources",
  releaseId: "win-user-1",
  directmlDeviceId: 2,
};
it("uses only pinned per-user runtime tools and selected GPU", () => {
  const config = windowsLocalConfig(input);
  expect(config).toMatchObject({
    platform: "win32",
    runtime_provider: "directml",
    directml_device_id: 2,
  });
  expect(config.node_path).toBe(
    "C:\\Users\\Example\\AppData\\Local\\MusicMuteLocal\\runtime\\releases\\win-user-1\\runtime\\node\\node.exe",
  );
  expect(config.python_path).toMatch(/runtime\\python\\python\.exe$/);
  expect(config.runner_path).toMatch(/resources\\engine\\local_pipeline\.py$/);
  expect(config.engine_root).toMatch(/app\\engine$/);
  expect(
    Object.values(config).some(
      (value) =>
        typeof value === "string" &&
        /Library\/|ProgramData|Program Files|homebrew/.test(value),
    ),
  ).toBe(false);
});
it.each([
  { ...input, releaseId: ".." },
  { ...input, directmlDeviceId: -1 },
  { ...input, directmlDeviceId: 16 },
  { ...input, appResources: "\\\\server\\share" },
  { ...input, host: { ...input.host, nativeArchitecture: "arm64" } },
])("rejects unqualified host and unsafe install identity", (value) =>
  expect(() => windowsLocalConfig(value)).toThrow(),
);
