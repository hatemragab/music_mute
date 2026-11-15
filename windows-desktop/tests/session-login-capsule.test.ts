import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.resetModules();
});
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function packagedFixture(catalog = false) {
  vi.resetModules();
  const trust = await import("../src/main/browser/package-trust.js"),
    root = await mkdtemp(join(tmpdir(), "musicmute-login-capsule-"));
  roots.push(root);
  const resources = join(root, "resources"),
    asar = join(resources, "app.asar");
  await mkdir(asar, { recursive: true });
  const entries = [];
  for (const key of [
    ...trust.REQUIRED_PACKAGED_RESOURCES,
    ...(catalog ? ["resources:worker-catalog-update-channel.json"] : []),
  ]) {
    const [placement, ...name] = key.split(":"),
      path = name.join(":"),
      bytes = Buffer.from(path);
    const destination = join(placement === "app" ? root : resources, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    entries.push({ placement, path, bytes: bytes.length, sha256: hash(bytes) });
  }
  await writeFile(
    join(asar, "packaged-resources.json"),
    JSON.stringify({
      version: 1,
      appId: "com.musicmute.local.windows",
      appVersion: "0.1.0",
      publisherSha256: "a".repeat(64),
      payloadSha256: "b".repeat(64),
      entries,
    }),
  );
  await trust.configurePackagedResourceTrust(resources, asar);
  return { trust, root, resources };
}
it("retains only an explicitly sealed optional catalog resource after GUI removal; unsealed presence cannot add authority", async () => {
  const plain = await packagedFixture();
  await writeFile(
    join(plain.resources, "worker-catalog-update-channel.json"),
    "unapproved catalog input",
  );
  expect(
    (await plain.trust.captureWorkerResourceCapsule()).capsule.entries,
  ).toHaveLength(5);
  const f = await packagedFixture(true);
  const snapshot = await f.trust.captureWorkerResourceCapsule();
  expect(snapshot.capsule.entries.map((entry) => entry.path)).toEqual([
    ...f.trust.WORKER_RESOURCE_PATHS,
    "worker-catalog-update-channel.json",
  ]);
  const capsule = Buffer.from(JSON.stringify(snapshot.capsule));
  vi.resetModules();
  const restored = await import("../src/main/browser/package-trust.js");
  await restored.configureWorkerResourceTrust(
    f.resources,
    capsule,
    hash(capsule),
  );
  expect(
    await restored.readPackagedResource(
      join(f.resources, "worker-catalog-update-channel.json"),
      16384,
    ),
  ).toEqual(Buffer.from("worker-catalog-update-channel.json"));
  expect(() =>
    restored.parseWorkerResourceCapsule({
      ...snapshot.capsule,
      entries: [...snapshot.capsule.entries, snapshot.capsule.entries[5]],
    }),
  ).toThrow("PACKAGED_TRUST_INVALID");
});
it("only a configured actual ASAR seal may publish the independent worker's public inputs", async () => {
  vi.resetModules();
  const trust = await import("../src/main/browser/package-trust.js");
  await expect(trust.captureWorkerResourceCapsule()).rejects.toThrow(
    "PACKAGED_TRUST_REQUIRED",
  );
  const f = await packagedFixture(),
    snapshot = await f.trust.captureWorkerResourceCapsule();
  expect(snapshot.capsule.entries.map((x) => x.path)).toEqual(
    f.trust.WORKER_RESOURCE_PATHS,
  );
  expect(snapshot.files.map((x) => x.path)).toEqual(
    f.trust.WORKER_RESOURCE_PATHS,
  );
  expect(
    snapshot.files.some((x) =>
      /credential|account-authority|model|\.exe/u.test(x.path),
    ),
  ).toBe(false);
  await writeFile(
    join(f.resources, "runtime-public-keys.json"),
    Buffer.from("changed"),
  );
  await expect(f.trust.captureWorkerResourceCapsule()).rejects.toThrow(
    "PACKAGED_TRUST_INVALID",
  );
});
it("a protected exact digest restores only the closed public capsule and every read repeats its byte binding", async () => {
  const f = await packagedFixture(),
    snapshot = await f.trust.captureWorkerResourceCapsule(),
    bytes = Buffer.from(JSON.stringify(snapshot.capsule)),
    digest = hash(bytes),
    root = join(f.root, "retained", "resources");
  for (const file of snapshot.files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
  }
  vi.resetModules();
  const trust = await import("../src/main/browser/package-trust.js");
  await expect(
    trust.configureWorkerResourceTrust(root, bytes, "c".repeat(64)),
  ).rejects.toThrow("PACKAGED_TRUST_INVALID");
  expect(await trust.configureWorkerResourceTrust(root, bytes, digest)).toEqual(
    snapshot.capsule,
  );
  expect(
    await trust.readPackagedResource(
      join(root, "runtime-public-keys.json"),
      16384,
    ),
  ).toEqual(Buffer.from("runtime-public-keys.json"));
  await expect(
    trust.readPackagedResource(
      join(root, "account-authority-manifest.json"),
      16384,
    ),
  ).rejects.toThrow("PACKAGED_TRUST_INVALID");
  await writeFile(
    join(root, "runtime-public-keys.json"),
    Buffer.from("changed"),
  );
  await expect(
    trust.readPackagedResource(join(root, "runtime-public-keys.json"), 16384),
  ).rejects.toThrow("PACKAGED_TRUST_INVALID");
});
it("capsule grammar rejects duplicate, reordered, missing, oversized or non-public entries", async () => {
  const f = await packagedFixture(),
    { capsule } = await f.trust.captureWorkerResourceCapsule();
  for (const mutate of [
    (row: typeof capsule) => ({ ...row, entries: row.entries.slice(1) }),
    (row: typeof capsule) => ({ ...row, entries: [...row.entries].reverse() }),
    (row: typeof capsule) => ({
      ...row,
      entries: row.entries.map((x, i) =>
        i === 0 ? { ...x, bytes: 16385 } : x,
      ),
    }),
    (row: typeof capsule) => ({
      ...row,
      entries: row.entries.map((x, i) =>
        i === 0 ? { ...x, path: "../credential" } : x,
      ),
    }),
    (row: typeof capsule) => ({ ...row, publisherSha256: "bad" }),
  ])
    expect(() => f.trust.parseWorkerResourceCapsule(mutate(capsule))).toThrow(
      "PACKAGED_TRUST_INVALID",
    );
});
