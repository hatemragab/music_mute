import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { diagnosticFixture } from "./diagnostics-fixtures.js";
import { WindowsDiagnosticJournal } from "../src/main/diagnostics/journal.js";
vi.mock("node:path", async () => {
  const path = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...path,
    win32: {
      ...path.win32,
      join: (...parts: string[]) =>
        path.join(...parts.flatMap((p) => p.split("\\"))),
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.resetModules();
});
const identity = {
  softwareVersion: "0.1.0",
  runtimeScope: "packaged-app" as const,
  expectedModelSha256: MODEL.sha256,
};
it("packaged diagnostics refuses missing trust while development reports no invented inventory", async () => {
  vi.resetModules();
  const { desktopDiagnosticIdentity } =
    await import("../src/main/diagnostics/desktop-identity.js");
  expect(() => desktopDiagnosticIdentity(identity)).toThrow(
    "DIAGNOSTICS_CONTEXT_INVALID",
  );
  expect(
    desktopDiagnosticIdentity({ ...identity, runtimeScope: "development" }),
  ).toEqual({ ...identity, runtimeScope: "development" });
});
it("binds the exact validated ASAR inventory bytes through the production identity builder into retained and Chrome reports", async () => {
  vi.resetModules();
  const trust = await import("../src/main/browser/package-trust.js"),
    { desktopDiagnosticIdentity } =
      await import("../src/main/diagnostics/desktop-identity.js"),
    { chromeDiagnosticSummary } =
      await import("../src/main/diagnostics/browser-report.js"),
    root = await mkdtemp(join(tmpdir(), "musicmute-diagnostics-seal-")),
    resources = join(root, "resources"),
    app = join(resources, "app.asar"),
    bytes = Buffer.from("source-only exact resource fixture"),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  roots.push(root);
  await mkdir(app, { recursive: true });
  const index = {
    version: 1,
    appId: "com.musicmute.local.windows",
    appVersion: "0.1.0",
    payloadSha256: "a".repeat(64),
    publisherSha256: "b".repeat(64),
    entries: trust.REQUIRED_PACKAGED_RESOURCES.map((name) => {
      const [placement, ...parts] = name.split(":");
      return { placement, path: parts.join(":"), bytes: bytes.length, sha256 };
    }),
  };
  for (const entry of index.entries) {
    const file = join(entry.placement === "app" ? root : resources, entry.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  const indexBytes = Buffer.from(JSON.stringify(index, null, 2));
  await writeFile(join(app, "packaged-resources.json"), indexBytes);
  await trust.configurePackagedResourceTrust(resources, app);
  const digest = createHash("sha256").update(indexBytes).digest("hex"),
    bound = desktopDiagnosticIdentity(identity),
    f = await diagnosticFixture();
  roots.push(f.root);
  expect(bound.packageInventorySha256).toBe(digest);
  expect(digest).not.toBe(index.payloadSha256);
  const journal = new WindowsDiagnosticJournal(f.host, bound);
  try {
    await journal.record({
      subsystem: "lifecycle",
      event: "started",
      code: "DESKTOP_STARTED",
      metrics: {},
    });
    const report = await journal.snapshot(true);
    expect(report.identity.packageInventorySha256).toBe(digest);
    expect(report.recentEvents[0]?.identity.packageInventorySha256).toBe(
      digest,
    );
    expect(
      chromeDiagnosticSummary(report).identity.packageInventorySha256,
    ).toBe(digest);
    await writeFile(
      join(resources, "desktop-build.json"),
      Buffer.alloc(bytes.length),
    );
    await expect(
      trust.configurePackagedResourceTrust(resources, app),
    ).rejects.toThrow("PACKAGED_TRUST_INVALID");
    expect(trust.packagedResourceInventorySha256()).toBe(digest);
  } finally {
    await journal.close();
  }
});
