import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  parsePackagedResourceIndex,
  REQUIRED_PACKAGED_RESOURCES,
} from "../src/main/browser/package-trust.js";
it("accepts only explicit sealed desktop build metadata and rejects mismatched versions or guessed/missing build numbers", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "musicmute-desktop-build-fixture-"),
  );
  roots.push(root);
  vi.resetModules();
  const trust = await import("../src/main/browser/package-trust.js");
  expect(trust.packagedResourceInventorySha256()).toBeNull();
  await writeFile(
    join(root, "desktop-build.json"),
    JSON.stringify({ version: 1, appVersion: "0.1.0", buildNumber: 42 }),
  );
  expect(await trust.loadPackagedDesktopBuild(root, "0.1.0")).toEqual({
    version: 1,
    appVersion: "0.1.0",
    buildNumber: 42,
  });
  await expect(trust.loadPackagedDesktopBuild(root, "0.2.0")).rejects.toThrow(
    "PACKAGED_TRUST_INVALID",
  );
  for (const bad of [
    { version: 1, appVersion: "0.1.0" },
    { version: 1, appVersion: "0.1.0", buildNumber: 0 },
    { version: 1, appVersion: "0.1.0", buildNumber: 42, unapproved: true },
  ]) {
    await writeFile(join(root, "desktop-build.json"), JSON.stringify(bad));
    await expect(trust.loadPackagedDesktopBuild(root)).rejects.toThrow(
      "PACKAGED_TRUST_INVALID",
    );
  }
});
const bytes = Buffer.from("source-only sealed resource fixture");
const digest = createHash("sha256").update(bytes).digest("hex");
function index() {
  return {
    version: 1,
    appId: "com.musicmute.local.windows",
    appVersion: "0.1.0",
    publisherSha256: "a".repeat(64),
    payloadSha256: "b".repeat(64),
    entries: REQUIRED_PACKAGED_RESOURCES.map((name) => {
      const [placement, ...path] = name.split(":");
      return {
        placement,
        path: path.join(":"),
        bytes: bytes.length,
        sha256: digest,
      };
    }),
  };
}
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.resetModules();
});
it("requires every approved resource and rejects duplicate paths, traversal, reserved names and circular self pins", () => {
  expect(parsePackagedResourceIndex(index()).entries).toHaveLength(
    REQUIRED_PACKAGED_RESOURCES.length,
  );
  const bad = [
    () => {
      const row = index();
      row.entries.pop();
      return row;
    },
    () => {
      const row = index();
      row.entries.push({
        ...row.entries[0]!,
        path: row.entries[0]!.path.toUpperCase(),
      });
      return row;
    },
    ...[
      "../foreign",
      "native//helper.exe",
      "native/NUL.json",
      "native/helper.exe.",
      "Native/Account-Authority-Manifest.json",
    ].map((path) => () => {
      const row = index();
      row.entries.push({
        placement: "resources",
        path,
        bytes: 1,
        sha256: digest,
      });
      return row;
    }),
  ];
  for (const fixture of bad)
    expect(() => parsePackagedResourceIndex(fixture())).toThrow(
      "PACKAGED_TRUST_INVALID",
    );
});
it("checks exact sealed bytes again on read and fences publisher substitution (directory ASAR fixture only)", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "musicmute-package-trust-fixture-"),
  );
  roots.push(root);
  const resources = join(root, "resources"),
    app = join(resources, "app.asar"),
    row = index();
  await mkdir(app, { recursive: true });
  for (const entry of row.entries) {
    const file = join(entry.placement === "app" ? root : resources, entry.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  await writeFile(join(app, "packaged-resources.json"), JSON.stringify(row));
  vi.resetModules();
  const trust = await import("../src/main/browser/package-trust.js");
  await trust.configurePackagedResourceTrust(resources, app);
  expect(trust.packagedResourceInventorySha256()).toBe(
    createHash("sha256").update(JSON.stringify(row)).digest("hex"),
  );
  expect(
    await trust.readPackagedResource(
      join(resources, "runtime-public-keys.json"),
      8192,
    ),
  ).toEqual(bytes);
  expect(() => trust.assertPackagedPublisher("c".repeat(64))).toThrow(
    "PACKAGED_TRUST_INVALID",
  );
  await writeFile(
    join(resources, "runtime-public-keys.json"),
    Buffer.alloc(bytes.length),
  );
  await expect(
    trust.readPackagedResource(
      join(resources, "runtime-public-keys.json"),
      8192,
    ),
  ).rejects.toThrow("PACKAGED_TRUST_INVALID");
  await expect(
    trust.readPostSignAppPin(join(resources, "foreign.json"), 4096),
  ).rejects.toThrow("PACKAGED_TRUST_INVALID");
});
it("refuses resource-directory links and mismatched ASAR roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-package-link-fixture-"));
  roots.push(root);
  const resources = join(root, "resources"),
    app = join(resources, "app.asar");
  await mkdir(app, { recursive: true });
  const row = index();
  for (const entry of row.entries) {
    const file = join(entry.placement === "app" ? root : resources, entry.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  await writeFile(join(app, "packaged-resources.json"), JSON.stringify(row));
  await rm(join(resources, "runtime"), { recursive: true });
  await mkdir(join(root, "foreign"));
  await symlink(join(root, "foreign"), join(resources, "runtime"));
  vi.resetModules();
  const trust = await import("../src/main/browser/package-trust.js");
  await expect(
    trust.configurePackagedResourceTrust(resources, join(root, "foreign.asar")),
  ).rejects.toThrow("PACKAGED_TRUST_INVALID");
  await expect(
    trust.configurePackagedResourceTrust(resources, app),
  ).rejects.toThrow("PACKAGED_TRUST_INVALID");
});
