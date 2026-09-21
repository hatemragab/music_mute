import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeLocalLifecycle,
  loadLocalLifecycle,
  localLifecycleAllowsClaims,
  setLocalLifecycleIntent,
} from "../src/runtime/local-lifecycle.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("local lifecycle state", () => {
  it("initializes active and applies atomic revisioned transitions", async () => {
    const root = await temporaryRoot();
    const path = join(root, "state", "lifecycle.json");

    const initial = await initializeLocalLifecycle(path);
    expect(initial.intent).toBe("active");
    expect(localLifecycleAllowsClaims(initial)).toBe(true);

    const paused = await setLocalLifecycleIntent(path, "paused");
    expect(paused).toMatchObject({ intent: "paused", revision: 2 });
    expect(localLifecycleAllowsClaims(paused)).toBe(false);

    const draining = await setLocalLifecycleIntent(path, "draining");
    expect(draining).toMatchObject({ intent: "draining", revision: 3 });
    expect(await loadLocalLifecycle(path)).toEqual(draining);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  it("does not overwrite an existing lifecycle during initialization", async () => {
    const root = await temporaryRoot();
    const path = join(root, "lifecycle.json");
    await initializeLocalLifecycle(path);
    await expect(initializeLocalLifecycle(path)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect((await loadLocalLifecycle(path)).revision).toBe(1);
  });

  it("rejects unsafe permissions and unknown fields", async () => {
    const root = await temporaryRoot();
    const unsafeMode = join(root, "unsafe-mode.json");
    await writeFile(
      unsafeMode,
      JSON.stringify({
        schemaVersion: 1,
        intent: "active",
        revision: 1,
        updatedAt: new Date().toISOString(),
      }),
      { mode: 0o644 },
    );
    await chmod(unsafeMode, 0o644);
    await expect(loadLocalLifecycle(unsafeMode)).rejects.toThrow("unsafe");

    const unknownField = join(root, "unknown.json");
    await writeFile(
      unknownField,
      JSON.stringify({
        schemaVersion: 1,
        intent: "active",
        revision: 1,
        updatedAt: new Date().toISOString(),
        credential: "must-not-be-accepted",
      }),
      { mode: 0o600 },
    );
    await expect(loadLocalLifecycle(unknownField)).rejects.toThrow("invalid");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-lifecycle-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
