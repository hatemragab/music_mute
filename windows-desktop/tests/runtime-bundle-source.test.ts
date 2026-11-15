import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  canonicalUpdateMetadata,
  type UpdateMetadata,
} from "../../worker/src/platform/shared/update-metadata.js";
import {
  loadPreparationBundle,
  preparationTargetIdentity,
} from "../src/main/prepare/bundle.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-sealed-source-code-"));
  roots.push(root);
  await mkdir(join(root, "runtime"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519"),
    metadata: UpdateMetadata = {
      schemaVersion: 1,
      sequence: 1,
      platform: "windows-amd64",
      installationProfile: "windows-user",
      releaseVersion: "0.1.0",
      publishedAt: "2026-10-08T00:00:00Z",
      expiresAt: "2026-11-08T00:00:00Z",
      release: {
        filename: "runtime.zip",
        bytes: 100,
        sha256: "f".repeat(64),
        contentType: "application/zip",
      },
    },
    target = preparationTargetIdentity(metadata),
    source = {
      version: 1,
      platform: "windows-amd64",
      installationProfile: "windows-user",
      targetIdentity: target,
      filename: metadata.release.filename,
      bytes: metadata.release.bytes,
      sha256: metadata.release.sha256,
      unpackedBytes: 1000,
      url: "https://downloads.music-mute.com/releases/test-only-fixture/runtime.zip",
    };
  await writeFile(
    join(root, "runtime-public-keys.json"),
    JSON.stringify({
      fixture: publicKey.export({ type: "spki", format: "pem" }),
    }),
  );
  await writeFile(
    join(root, "runtime", "runtime-metadata.json"),
    JSON.stringify({
      keyId: "fixture",
      metadata,
      signature: sign(
        null,
        Buffer.from(canonicalUpdateMetadata(metadata)),
        privateKey,
      ).toString("base64url"),
    }),
  );
  await writeFile(
    join(root, "runtime", "runtime-source.json"),
    JSON.stringify(source),
  );
  return { root, metadata, target, source };
}
it("loads a signed metadata-bound source without requiring a pre-staged runtime ZIP", async () => {
  const f = await fixture(),
    bundle = await loadPreparationBundle(f.root, 1, new Date("2026-10-09"));
  expect(bundle.source).toEqual(f.source);
  expect(bundle.allowNetwork).toBe(true);
  expect(bundle.targetIdentity).toBe(f.target);
});
it("rejects a source changed away from authenticated artifact identity", async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, "runtime", "runtime-source.json"),
    JSON.stringify({ ...f.source, sha256: "a".repeat(64) }),
  );
  await expect(
    loadPreparationBundle(f.root, 1, new Date("2026-10-09")),
  ).rejects.toThrow("INTEGRITY_INVALID");
});
it("exact activated offline expiry exception never permits fresh network installation", async () => {
  const f = await fixture();
  const bundle = await loadPreparationBundle(
    f.root,
    1,
    new Date("2026-12-09"),
    { target: f.target, sequence: 1, activatedAt: "2026-10-09T00:00:00Z" },
  );
  expect(bundle.source).toEqual(f.source);
  expect(bundle.allowNetwork).toBe(false);
  await expect(
    loadPreparationBundle(f.root, 1, new Date("2026-12-09")),
  ).rejects.toThrow("INTEGRITY_INVALID");
});
