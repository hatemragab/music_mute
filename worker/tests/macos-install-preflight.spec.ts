import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectInstalledMacRuntime,
  parseFfmpegVersion,
  parseNodeVersion,
} from "../src/platform/macos/install-preflight.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("macOS install runtime preflight", () => {
  it("reuses trusted compatible components without downloading", async () => {
    const root = await executableRoot();
    const node = await executable(root, "node");
    const ffmpeg = await executable(root, "ffmpeg");
    const ffprobe = await executable(root, "ffprobe");
    const outputs = new Map([
      ["node", "v24.18.0"],
      ["ffmpeg", "ffmpeg version 8.0.3 Copyright"],
      ["ffprobe", "ffprobe version 8.0.3 Copyright"],
    ]);
    const result = await inspectInstalledMacRuntime({
      nodeCandidates: [node],
      ffmpegCandidates: [ffmpeg],
      ffprobeCandidates: [ffprobe],
      execute: async (path) => outputs.get(basename(path))!,
      uid: process.getuid!(),
    });
    expect(result.node).toMatchObject({
      decision: "reuse",
      reason: "compatible",
    });
    expect(result.ffmpeg).toMatchObject({
      decision: "reuse",
      reason: "compatible",
    });
    expect(result.ffprobe).toMatchObject({
      decision: "reuse",
      reason: "compatible",
    });
  });

  it("selects a private install for old, missing, or untrusted components", async () => {
    const root = await executableRoot();
    const node = await executable(root, "node");
    const ffmpeg = await executable(root, "ffmpeg");
    await chmod(ffmpeg, 0o777);
    const result = await inspectInstalledMacRuntime({
      nodeCandidates: [node],
      ffmpegCandidates: [ffmpeg],
      ffprobeCandidates: [join(root, "missing-ffprobe")],
      execute: async (path) =>
        basename(path) === "node"
          ? "v23.11.1"
          : "ffmpeg version 8.0.3 Copyright",
      uid: process.getuid!(),
    });
    expect(result.node).toMatchObject({
      decision: "install-private",
      installedVersion: "23.11.1",
      reason: "older",
    });
    expect(result.ffmpeg).toMatchObject({
      decision: "install-private",
      reason: "untrusted",
    });
    expect(result.ffprobe).toMatchObject({
      decision: "install-private",
      reason: "missing",
    });
  });

  it("upgrades an otherwise trusted Node and FFmpeg pair below the minimums", async () => {
    const root = await executableRoot();
    const node = await executable(root, "node");
    const ffmpeg = await executable(root, "ffmpeg");
    const ffprobe = await executable(root, "ffprobe");
    const outputs = new Map([
      ["node", "v23.11.1"],
      ["ffmpeg", "ffmpeg version 8.0.1 Copyright"],
      ["ffprobe", "ffprobe version 8.0.1 Copyright"],
    ]);
    const result = await inspectInstalledMacRuntime({
      nodeCandidates: [node],
      ffmpegCandidates: [ffmpeg],
      ffprobeCandidates: [ffprobe],
      execute: async (path) => outputs.get(basename(path))!,
      uid: process.getuid!(),
    });
    expect(result.node).toMatchObject({
      decision: "install-private",
      installedVersion: "23.11.1",
      requestedVersion: "24.18.0",
      reason: "older",
    });
    expect(result.ffmpeg).toMatchObject({
      decision: "install-private",
      installedVersion: "8.0.1",
      requestedVersion: "8.0.3",
      reason: "older",
    });
    expect(result.ffprobe).toMatchObject({
      decision: "install-private",
      installedVersion: "8.0.1",
      requestedVersion: "8.0.3",
      reason: "older",
    });
  });

  it("rejects newer incompatible major versions and malformed output", async () => {
    const root = await executableRoot();
    const node = await executable(root, "node");
    const ffmpeg = await executable(root, "ffmpeg");
    const ffprobe = await executable(root, "ffprobe");
    const outputs = new Map([
      ["node", "v25.0.0"],
      ["ffmpeg", "not ffmpeg"],
      ["ffprobe", "ffprobe version 9.0 Copyright"],
    ]);
    const result = await inspectInstalledMacRuntime({
      nodeCandidates: [node],
      ffmpegCandidates: [ffmpeg],
      ffprobeCandidates: [ffprobe],
      execute: async (path) => outputs.get(basename(path))!,
      uid: process.getuid!(),
    });
    expect(result.node.reason).toBe("incompatible");
    expect(result.ffmpeg.reason).toBe("incompatible");
    expect(result.ffprobe.reason).toBe("incompatible");
  });

  it("upgrades FFmpeg and FFprobe together when the installed pair is incomplete or mismatched", async () => {
    const root = await executableRoot();
    const node = await executable(root, "node");
    const ffmpeg = await executable(root, "ffmpeg");
    const ffprobe = await executable(root, "ffprobe");
    const mismatched = await inspectInstalledMacRuntime({
      nodeCandidates: [node],
      ffmpegCandidates: [ffmpeg],
      ffprobeCandidates: [ffprobe],
      execute: async (path) => {
        const name = basename(path);
        if (name === "node") return "v24.18.0";
        return `${name} version ${name === "ffmpeg" ? "8.0.3" : "8.0.4"}`;
      },
      uid: process.getuid!(),
    });
    expect(mismatched.ffmpeg.reason).toBe("incompatible");
    expect(mismatched.ffprobe.reason).toBe("incompatible");

    const incomplete = await inspectInstalledMacRuntime({
      nodeCandidates: [node],
      ffmpegCandidates: [ffmpeg],
      ffprobeCandidates: [join(root, "missing-ffprobe")],
      execute: async (path) =>
        basename(path) === "node" ? "v24.18.0" : "ffmpeg version 8.0.3",
      uid: process.getuid!(),
    });
    expect(incomplete.ffmpeg.reason).toBe("incompatible");
    expect(incomplete.ffprobe.reason).toBe("missing");
  });

  it("parses only the expected version formats", () => {
    expect(parseNodeVersion("v24.18.0\n")).toBe("24.18.0");
    expect(parseNodeVersion("node 24.18.0")).toBeNull();
    expect(parseFfmpegVersion("ffmpeg version 8.0.3 Copyright")).toBe("8.0.3");
    expect(parseFfmpegVersion("ffprobe version 8.0 Copyright")).toBe("8.0");
  });
});

async function executableRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-preflight-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

async function executable(root: string, name: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, "test executable", { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}
