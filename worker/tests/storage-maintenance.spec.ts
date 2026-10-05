import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupWorkerStorage,
  WORKER_CACHE_LIMIT_BYTES,
  type WorkerStorageLayout,
} from "../src/platform/shared/storage-maintenance.js";

const roots: string[] = [];
const now = Date.now();
const DAY = 86400000;
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-storage-"));
  roots.push(root);
  const installRoot = join(root, "worker");
  const layout: WorkerStorageLayout = {
    installRoot,
    releasesRoot: join(installRoot, "runtime", "releases"),
    transactionRoot: join(installRoot, "state", "transactions"),
    workRoot: join(installRoot, "jobs", "attempts"),
    cacheRoot: join(installRoot, "cache"),
    temporaryRoot: join(installRoot, "tmp"),
    updateStatePath: join(installRoot, "state", "update.json"),
    recoveryPaths: [
      join(
        installRoot,
        "state",
        "transactions",
        "install",
        "finalization.json",
      ),
    ],
    activeVersion: async () => "0.1.3",
    verifyRelease: async () => undefined,
    transactionName: (name) => ["install", "updates"].includes(name),
  };
  const put = async (path: string, value = "retained") => {
    const parent = path.slice(0, path.lastIndexOf("/"));
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await writeFile(path, value, { mode: 0o600 });
  };
  for (const version of ["0.1.0", "0.1.1", "0.1.2", "0.1.3"])
    await put(join(layout.releasesRoot, version, "runtime.bin"));
  await put(join(layout.transactionRoot, "updates", "4", "archive.tar.gz"));
  await put(join(layout.transactionRoot, "install", "runtime.bin"));
  await put(
    layout.updateStatePath,
    JSON.stringify({
      schemaVersion: 1,
      highestSequence: 4,
      status: "healthy",
      knownGoodVersion: "0.1.3",
      quarantinedVersions: [],
    }),
  );
  await put(join(layout.workRoot, "qualification-old", "input.wav"));
  await utimes(
    join(layout.workRoot, "qualification-old"),
    (now - 2 * DAY) / 1000,
    (now - 2 * DAY) / 1000,
  );
  await put(join(layout.workRoot, "qualification-recent", "input.wav"));
  await put(
    join(layout.workRoot, "582df8f8-43b5-4e16-9fdf-bf2234447d5b", "input.wav"),
  );
  await put(join(installRoot, "models", "model.onnx"));
  await put(join(installRoot, "config", "runtime.json"));
  await put(join(installRoot, "credentials", "machine.credential"));
  await put(join(installRoot, "state", "qualification.wav"));
  await put(join(installRoot, "jobs", "logs", "diagnostics.json"));
  await put(join(layout.temporaryRoot, "stale", "scratch.wav"));
  await utimes(
    join(layout.temporaryRoot, "stale"),
    (now - 2 * DAY) / 1000,
    (now - 2 * DAY) / 1000,
  );
  await put(join(layout.temporaryRoot, "recent.wav"));
  await mkdir(layout.cacheRoot, { mode: 0o700 });
  return { root, layout, put };
}

describe("worker disk maintenance", () => {
  it("previews then removes only scratch and old releases, preserving rollback, media, credentials and history", async () => {
    const f = await fixture();
    const preview = await cleanupWorkerStorage({ layout: f.layout, now });
    expect(preview.status).toBe("ok");
    expect(preview.reclaimedBytes).toBe(0);
    expect(preview.reclaimableBytes).toBeGreaterThan(0);
    expect(preview.keptReleaseVersions).toEqual(["0.1.3", "0.1.2"]);
    expect(
      await readFile(
        join(f.layout.transactionRoot, "updates", "4", "archive.tar.gz"),
        "utf8",
      ),
    ).toBe("retained");
    const applied = await cleanupWorkerStorage({
      layout: f.layout,
      apply: true,
      now,
    });
    expect(applied.reclaimedBytes).toBe(preview.reclaimableBytes);
    expect(applied.entries.every((entry) => entry.removed)).toBe(true);
    await expect(
      readFile(join(f.layout.workRoot, "qualification-old", "input.wav")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of [
      "runtime/releases/0.1.3/runtime.bin",
      "runtime/releases/0.1.2/runtime.bin",
      "jobs/attempts/582df8f8-43b5-4e16-9fdf-bf2234447d5b/input.wav",
      "jobs/attempts/qualification-recent/input.wav",
      "models/model.onnx",
      "config/runtime.json",
      "credentials/machine.credential",
      "state/qualification.wav",
      "jobs/logs/diagnostics.json",
      "tmp/recent.wav",
    ])
      expect(await readFile(join(f.layout.installRoot, path), "utf8")).toBe(
        "retained",
      );
    const repeated = await cleanupWorkerStorage({
      layout: f.layout,
      apply: true,
      now,
    });
    expect(repeated.reclaimedBytes).toBe(0);
  });

  it.each(["staged", "activating", "corrupt", "recovery", "mismatched"])(
    "fails closed for %s update state",
    async (state) => {
      const f = await fixture();
      const update = {
        schemaVersion: 1,
        highestSequence: 4,
        status:
          state === "recovery" || state === "mismatched" ? "healthy" : state,
        knownGoodVersion: state === "mismatched" ? "0.1.2" : "0.1.3",
        quarantinedVersions: [],
        ...(state === "recovery" ? { recovery: {} } : {}),
      };
      await f.put(f.layout.updateStatePath, JSON.stringify(update));
      const result = await cleanupWorkerStorage({
        layout: f.layout,
        apply: true,
        now,
      });
      expect(result.status).toBe("blocked");
      expect(result.reclaimedBytes).toBe(0);
      expect(
        await readFile(
          join(f.layout.transactionRoot, "updates", "4", "archive.tar.gz"),
          "utf8",
        ),
      ).toBe("retained");
    },
  );

  it("protects any recovery journal even when it is malformed or linked", async () => {
    const f = await fixture();
    await f.put(f.layout.recoveryPaths[0]!, "{");
    expect(
      (await cleanupWorkerStorage({ layout: f.layout, apply: true })).status,
    ).toBe("blocked");
    await rm(f.layout.recoveryPaths[0]!);
    await symlink(join(f.root, "missing"), f.layout.recoveryPaths[0]!);
    expect(
      (await cleanupWorkerStorage({ layout: f.layout, apply: true })).status,
    ).toBe("blocked");
  });

  it("rejects linked roots and never follows links inside scratch", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside");
    await f.put(join(outside, "keep.wav"));
    await symlink(
      outside,
      join(f.layout.transactionRoot, "updates", "external"),
    );
    await symlink(outside, join(f.layout.cacheRoot, "external"));
    await cleanupWorkerStorage({ layout: f.layout, apply: true, now });
    expect(await readFile(join(outside, "keep.wav"), "utf8")).toBe("retained");
    await rm(f.layout.cacheRoot, { recursive: true });
    await symlink(outside, f.layout.cacheRoot);
    await expect(
      cleanupWorkerStorage({ layout: f.layout, apply: true }),
    ).rejects.toThrow("unsafe ancestor");
  });

  it("refuses cleanup when the active release disappeared", async () => {
    const f = await fixture();
    await rm(join(f.layout.releasesRoot, "0.1.3"), { recursive: true });
    await expect(
      cleanupWorkerStorage({ layout: f.layout, apply: true }),
    ).rejects.toThrow("unavailable");
    expect(
      await readFile(
        join(f.layout.releasesRoot, "0.1.2", "runtime.bin"),
        "utf8",
      ),
    ).toBe("retained");
  });

  it("prunes oldest caches over budget and expires caches older than thirty days", async () => {
    const f = await fixture();
    const oldest = join(f.layout.cacheRoot, "old.pyc");
    const oversized = join(f.layout.cacheRoot, "oversized.nbc");
    const recent = join(f.layout.cacheRoot, "recent.pyc");
    await f.put(oldest);
    await utimes(oldest, (now - 31 * DAY) / 1000, (now - 31 * DAY) / 1000);
    await f.put(oversized, "");
    await truncate(oversized, WORKER_CACHE_LIMIT_BYTES + 1);
    await utimes(oversized, (now - DAY) / 1000, (now - DAY) / 1000);
    await f.put(recent);
    const result = await cleanupWorkerStorage({
      layout: f.layout,
      apply: true,
      now,
    });
    expect(
      result.entries
        .filter((entry) => entry.category === "cache")
        .map((entry) => entry.path),
    ).toEqual(["cache/old.pyc", "cache/oversized.nbc"]);
    expect(await readFile(recent, "utf8")).toBe("retained");
  });

  it("reports cleanup failures without claiming bytes were reclaimed", async () => {
    const f = await fixture();
    const result = await cleanupWorkerStorage({
      layout: f.layout,
      apply: true,
      now,
      remove: async () => {
        throw new Error("permission denied");
      },
    });
    expect(result.status).toBe("partial");
    expect(result.reclaimedBytes).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.entries.every((entry) => !entry.removed)).toBe(true);
  });

  it("protects the latest usable rollback and does not retain a quarantined release", async () => {
    const f = await fixture();
    await f.put(
      f.layout.updateStatePath,
      JSON.stringify({
        schemaVersion: 1,
        highestSequence: 4,
        status: "healthy",
        quarantinedVersions: ["0.1.2"],
      }),
    );
    const result = await cleanupWorkerStorage({
      layout: f.layout,
      apply: true,
    });
    expect(result.keptReleaseVersions).toEqual(["0.1.3", "0.1.1"]);
  });

  it("keeps a verified older rollback instead of a newer orphan or corrupt previous release", async () => {
    const f = await fixture();
    await f.put(join(f.layout.releasesRoot, "0.1.4", "runtime.bin"));
    f.layout.verifyRelease = async (version) => {
      if (version === "0.1.2") throw new Error("corrupt release");
    };
    const result = await cleanupWorkerStorage({
      layout: f.layout,
      apply: true,
    });
    expect(result.keptReleaseVersions).toEqual(["0.1.3", "0.1.1"]);
    expect(
      await readFile(
        join(f.layout.releasesRoot, "0.1.1", "runtime.bin"),
        "utf8",
      ),
    ).toBe("retained");
  });

  it("recognizes only a matching durably completed legacy enrollment", async () => {
    const f = await fixture();
    const legacy = {
      statePath: join(
        f.layout.transactionRoot,
        "install",
        ".enrollment-state.json",
      ),
      installationPath: join(
        f.layout.installRoot,
        "state",
        "installation.json",
      ),
      configPath: join(f.layout.installRoot, "config", "runtime.json"),
    };
    f.layout.legacyEnrollment = legacy;
    await f.put(
      legacy.statePath,
      JSON.stringify({
        schemaVersion: 1,
        installationId: "installation-1",
        machineId: "machine-1",
      }),
    );
    await f.put(
      legacy.installationPath,
      JSON.stringify({
        schemaVersion: 1,
        installationId: "installation-1",
        machineId: "machine-2",
      }),
    );
    await f.put(
      legacy.configPath,
      JSON.stringify({ schemaVersion: 1, machineId: "machine-1" }),
    );
    expect(
      (await cleanupWorkerStorage({ layout: f.layout, apply: true })).status,
    ).toBe("blocked");
    await f.put(
      legacy.installationPath,
      JSON.stringify({
        schemaVersion: 1,
        installationId: "installation-1",
        machineId: "machine-1",
      }),
    );
    expect(
      (await cleanupWorkerStorage({ layout: f.layout, apply: true })).status,
    ).toBe("ok");
    await expect(readFile(legacy.statePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("service-account maintenance modifies state scratch only", async () => {
    const f = await fixture();
    const result = await cleanupWorkerStorage({
      layout: f.layout,
      apply: true,
      now,
      stateOnly: true,
    });
    expect(
      result.entries.some((entry) =>
        ["older-release", "completed-transaction"].includes(entry.category),
      ),
    ).toBe(false);
    expect(
      await readFile(
        join(f.layout.releasesRoot, "0.1.0", "runtime.bin"),
        "utf8",
      ),
    ).toBe("retained");
    expect(
      await readFile(
        join(f.layout.transactionRoot, "updates", "4", "archive.tar.gz"),
        "utf8",
      ),
    ).toBe("retained");
    await expect(
      readFile(join(f.layout.workRoot, "qualification-old", "input.wav")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
