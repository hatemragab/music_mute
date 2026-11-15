import { describe, expect, it, vi } from "vitest";
import { publishFleetChildConfiguration } from "../src/main/fleet/configuration.js";
import type { SessionRuntimeContext } from "../src/main/session/context.js";
const files = vi.hoisted(() => ({
  open: vi.fn(),
  lstat: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("node:fs/promises", () => files);
function fixture() {
  vi.clearAllMocks();
  const bytes: Buffer[] = [],
    file = {
      writeFile: vi.fn(async (value: Buffer) => {
        bytes.push(value);
      }),
      sync: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    },
    fleetRoot = "C:\\Users\\fixture\\AppData\\Local\\MusicMuteWorker",
    configuration = {
      version: 1,
      kind: "session-agent",
      installationProfile: "windows-user",
      release: "a".repeat(64),
      releaseRoot:
        "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal\\runtime\\releases\\" +
        "a".repeat(64),
      personalRoot: "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal",
      fleetRoot,
      nativeSha256: "b".repeat(64),
      launchFiles: {},
    },
    native = {
      ensurePrivateDirectory: vi.fn(async () => fleetRoot),
      validatePath: vi.fn(async () => {}),
      vaultWrite: vi.fn(async () => {}),
    },
    context = { configuration, native } as unknown as SessionRuntimeContext;
  files.open.mockResolvedValue(file);
  files.lstat.mockRejectedValue(
    Object.assign(new Error("missing"), { code: "ENOENT" }),
  );
  files.rename.mockResolvedValue(undefined);
  files.rm.mockResolvedValue(undefined);
  return { context, native, file, bytes };
}
describe("fixed fleet child bootstrap publication", () => {
  it("publishes only fixed paths and a private SHA receipt, never enrollment credentials", async () => {
    const f = fixture();
    await publishFleetChildConfiguration(f.context);
    expect(JSON.parse(f.bytes[0]!.toString())).toEqual({
      version: 1,
      kind: "fleet",
      installationProfile: "windows-user",
      releaseRoot: f.context.configuration.releaseRoot,
      personalRoot: f.context.configuration.personalRoot,
      fleetRoot: f.context.configuration.fleetRoot,
      nativeSha256: "b".repeat(64),
    });
    expect(f.file.sync).toHaveBeenCalledOnce();
    expect(files.rename).toHaveBeenCalledOnce();
    expect(f.native.vaultWrite).toHaveBeenCalledWith(
      "fleet",
      "child_bootstrap",
      expect.any(Buffer),
    );
    expect(f.native.validatePath).toHaveBeenCalledWith(
      "fleet",
      "consumer-config.json",
      "absent",
    );
    expect(f.native.validatePath).toHaveBeenCalledWith(
      "fleet",
      "consumer-config.json",
      "file",
    );
  });
  it("refuses a root that does not match the actual private native directory", async () => {
    const f = fixture();
    f.native.ensurePrivateDirectory.mockResolvedValue("C:\\other-user");
    await expect(publishFleetChildConfiguration(f.context)).rejects.toThrow(
      "FLEET_CONTEXT_INVALID",
    );
    expect(files.open).not.toHaveBeenCalled();
  });
  it("a failed atomic rename cannot publish a successful bootstrap receipt", async () => {
    const f = fixture();
    files.rename.mockRejectedValue(new Error("disk failure"));
    await expect(publishFleetChildConfiguration(f.context)).rejects.toThrow(
      "disk failure",
    );
    expect(f.file.close).toHaveBeenCalledOnce();
    expect(f.native.vaultWrite).not.toHaveBeenCalled();
    expect(files.rm).toHaveBeenCalledWith(
      expect.stringMatching(/consumer-config\.[a-f0-9-]+\.tmp$/),
      { force: true },
    );
  });
});
