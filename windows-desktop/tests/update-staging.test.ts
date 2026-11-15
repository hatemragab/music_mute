import { privateFileNativeFixture } from "./private-file-port-fixture.js";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  lstat,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { ConsumerUpdateStager } from "../src/main/update/storage.js";
import { consumerUpdateIdentity } from "../src/main/update/metadata.js";
import type { HostContext } from "../src/main/host-context.js";
import type { ConsumerUpdateMetadata } from "../src/shared/update-contracts.js";
// Only Windows path spelling is adapted; real file/hash/downloader behavior runs with synthetic HTTP.
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.flatMap((x) => x.split("\\"))),
    },
  };
});
it("cold stage and verification consume only signed app bytes, never the runtime or model URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-cold-stage-"));
  try {
    const bytes = Buffer.from("synthetic installer bytes"),
      sha = createHash("sha256").update(bytes).digest("hex"),
      origin = "https://updates.example.invalid";
    const artifact = (kind: string, type: string) => ({
      filename: `${kind}.${kind === "app" ? "exe" : kind === "runtime" ? "zip" : "onnx"}`,
      url: `${origin}/${kind}`,
      bytes: kind === "app" ? bytes.length : 1024 ** 3,
      sha256: kind === "app" ? sha : "c".repeat(64),
      contentType: type,
    });
    const metadata: ConsumerUpdateMetadata = {
      schemaVersion: 1,
      installationProfile: "windows-user",
      platform: "windows-amd64",
      channel: "stable",
      sequence: 2,
      publishedAt: "2026-10-09T00:00:00Z",
      expiresAt: "2027-10-09T00:00:00Z",
      dataSchema: 1,
      publisherSha256: "9".repeat(64),
      app: {
        version: "2.0.0",
        payloadSha256: "a".repeat(64),
        artifact: artifact("app", "application/x-msdownload"),
      },
      runtime: {
        version: "2.0.0",
        minimumAppVersion: "1.0.0",
        artifact: artifact("runtime", "application/zip"),
      },
      model: {
        version: "1.0.0",
        minimumRuntimeVersion: "1.0.0",
        artifact: artifact("model", "application/octet-stream"),
      },
      required: {
        minimumAppVersion: "1.0.0",
        minimumRuntimeVersion: "1.0.0",
        minimumModelVersion: "1.0.0",
      },
    };
    const path = (relative: string) => join(root, ...relative.split("\\")),
      native = {
        ...privateFileNativeFixture(path),
        ensurePrivateDirectory: async (_ns: string, relative: string) => {
          await mkdir(path(relative), { recursive: true, mode: 0o700 });
          return path(relative);
        },
        validatePath: vi.fn(
          async (_ns: string, relative: string, kind: string) => {
            if (kind === "absent") {
              await expect(lstat(path(relative))).rejects.toMatchObject({
                code: "ENOENT",
              });
              return;
            }
            const stat = await lstat(path(relative));
            if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
              throw new Error("ACL_UNSAFE");
          },
        ),
      };
    const host = { native, personalRoot: root } as unknown as HostContext,
      fetcher = vi.fn(
        async (_input: RequestInfo | URL) =>
          new Response(bytes, {
            headers: {
              "content-type": "application/x-msdownload",
              "content-length": String(bytes.length),
            },
          }),
      ),
      stager = new ConsumerUpdateStager(
        host,
        {
          feed: `${origin}/feed`,
          allowedOrigins: [origin],
          publicKeys: {},
          publisherSha256: "9".repeat(64),
        },
        fetcher as typeof fetch,
      ),
      signal = new AbortController().signal,
      transaction = "10000000-0000-4000-8000-000000000001";
    await stager.stage(metadata, transaction, signal, ["app"]);
    await stager.verifyStage(metadata, transaction, signal, ["app"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(metadata.app.artifact.url);
    const directory = `updates\\staging\\${consumerUpdateIdentity(metadata)}`;
    expect(await readFile(path(`${directory}\\installer.exe`))).toEqual(bytes);
    expect(
      native.validatePath.mock.calls.every(
        ([, relative]) =>
          !relative.endsWith("runtime.zip") && !relative.endsWith("model.onnx"),
      ),
    ).toBe(true);
    await writeFile(
      path(`${directory}\\installer.exe`),
      Buffer.alloc(bytes.length),
    );
    await expect(
      stager.verifyStage(metadata, transaction, signal, ["app"]),
    ).rejects.toThrow("UPDATE_HASH_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
