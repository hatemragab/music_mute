import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  link,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markJobWorkspace,
  recoverJobWorkspaces,
  releaseJobWorkspace,
} from "../src/companion/job-workspace.js";
import * as processStart from "../src/companion/process-start.js";

const roots: string[] = [];
beforeEach(() => {
  vi.spyOn(processStart, "processStartIdentity").mockResolvedValue(
    "a".repeat(64),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mm-job-workspace-"));
  roots.push(root);
  const cache = join(root, "cache");
  await mkdir(join(cache, "jobs"), { recursive: true, mode: 0o700 });
  return { root, cache };
}
async function stage(
  cache: string,
  files: Record<string, string>,
  dead = true,
) {
  const id = randomUUID();
  const root = join(cache, "jobs", id);
  const marker = join(cache, "job-workspaces", `${id}.json`);
  await mkdir(root, { mode: 0o700 });
  await markJobWorkspace(cache, id);
  for (const [name, bytes] of Object.entries(files)) {
    if (name.includes("/"))
      await mkdir(join(root, name.split("/")[0]!), { mode: 0o700 });
    await writeFile(join(root, name), bytes, { mode: 0o600 });
  }
  if (dead) {
    const value = JSON.parse(await readFile(marker, "utf8"));
    await writeFile(marker, JSON.stringify({ ...value, pid: 2_147_483_647 }), {
      mode: 0o600,
    });
  }
  return { id, root, marker };
}

describe("owned processing workspace crash recovery", () => {
  it("keeps identity sidecars outside the engine's source-only directory and releases only its own marker", async () => {
    const e = await fixture();
    const work = await stage(e.cache, {}, false);
    expect(await readdir(work.root)).toEqual([]);
    const record = JSON.parse(await readFile(work.marker, "utf8"));
    expect(record).toEqual({
      version: 1,
      job_id: work.id,
      pid: process.pid,
      process_start: "a".repeat(64),
      incarnation: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
    expect(
      Object.keys(record).some((key) =>
        /path|url|title|token|owner|credential/.test(key),
      ),
    ).toBe(false);
    await rm(work.root, { recursive: true });
    await releaseJobWorkspace(e.cache, work.id);
    expect(await readdir(join(e.cache, "job-workspaces"))).toEqual([]);
  });
  it("removes dead proven source/decoder/inference scratch without touching the user's selected file", async () => {
    const e = await fixture();
    const selected = join(e.root, "user-selected.wav");
    await writeFile(selected, "user original");
    const work = await stage(e.cache, {
      "source.wav": "app original",
      "source.m4a.part": "partial transfer",
      "source.m4a.ytdl": "bounded resume",
      "prepared.wav": "decoded",
      "separated/vocals.wav": "lossless voice",
      "output/vocals.mp3": "encoded voice",
    });
    expect(await recoverJobWorkspaces(e.cache)).toMatchObject({
      removed: 1,
      preserved: 0,
    });
    await expect(readFile(work.marker)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readdir(work.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(selected, "utf8")).toBe("user original");
  });
  it("cleans interrupted owned cloud upload and downloaded vocals scratch", async () => {
    const e = await fixture();
    const work = await stage(e.cache, {
      "source.webm": "acquired original",
      "cloud.m4a": "prepared upload",
      "vocals.mp3": "validated download",
    });
    expect(await recoverJobWorkspaces(e.cache)).toMatchObject({
      removed: 1,
      preserved: 0,
    });
    await expect(readdir(work.root)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves live, reused and unknown process identities, unmarked legacy work and both ticket publication phases", async () => {
    const e = await fixture();
    const live = await stage(
      e.cache,
      { "source.mp3": "active original" },
      false,
    );
    vi.mocked(processStart.processStartIdentity)
      .mockResolvedValueOnce("b".repeat(64))
      .mockRejectedValueOnce(new Error("PROCESS_IDENTITY_UNAVAILABLE"));
    expect(await recoverJobWorkspaces(e.cache)).toMatchObject({
      removed: 0,
      preserved: 1,
    });
    expect(await recoverJobWorkspaces(e.cache)).toMatchObject({
      removed: 0,
      preserved: 1,
    });
    const legacy = join(e.cache, "jobs", randomUUID());
    await mkdir(legacy, { mode: 0o700 });
    await writeFile(join(legacy, "source.wav"), "unmarked original", {
      mode: 0o600,
    });
    const completed = await stage(e.cache, {
      "source.wav": "pending pair",
      "local-sync-recovery.json": "ticket owned by outbox",
    });
    const temporary = await stage(e.cache, {
      "source.wav": "pre-rename pair",
      [`.local-sync-${randomUUID()}.tmp`]: "ticket owned by outbox",
    });
    expect(await recoverJobWorkspaces(e.cache)).toMatchObject({
      removed: 0,
      preserved: 3,
    });
    for (const work of [live, completed, temporary])
      expect(await readdir(work.root)).not.toEqual([]);
    expect(await readFile(join(legacy, "source.wav"), "utf8")).toBe(
      "unmarked original",
    );
  });
  it.each([
    "unexpected",
    "symlink",
    "hardlink",
    "writable",
    "marker",
    "oversized",
  ])("refuses %s state and preserves the source", async (failure) => {
    const e = await fixture();
    const work = await stage(e.cache, { "source.wav": "owned original" });
    const source = join(work.root, "source.wav");
    if (failure === "unexpected")
      await writeFile(join(work.root, "foreign.txt"), "keep", { mode: 0o600 });
    if (failure === "symlink")
      await symlink(source, join(work.root, "prepared.wav"));
    if (failure === "hardlink")
      await link(source, join(work.root, "prepared.wav"));
    if (failure === "writable") {
      const { chmod } = await import("node:fs/promises");
      await chmod(source, 0o644);
    }
    if (failure === "marker") {
      const value = JSON.parse(await readFile(work.marker, "utf8"));
      await writeFile(
        work.marker,
        JSON.stringify({ ...value, pid: -1, path: source }),
        { mode: 0o600 },
      );
    }
    if (failure === "oversized") {
      const { truncate } = await import("node:fs/promises");
      await truncate(source, 256 * 1024 ** 2 + 1);
    }
    await expect(recoverJobWorkspaces(e.cache)).rejects.toThrow("CACHE_UNSAFE");
    expect(await readdir(work.root)).toContain("source.wav");
    expect(await readFile(work.marker, "utf8")).not.toBe("");
  });
  it("removes only stale metadata after the outbox has already consumed its workspace", async () => {
    const e = await fixture();
    const work = await stage(e.cache, { "source.wav": "outbox source" });
    await rm(work.root, { recursive: true });
    expect(await recoverJobWorkspaces(e.cache)).toEqual({
      removed: 0,
      bytes: 0,
      preserved: 0,
    });
    expect(await readdir(join(e.cache, "job-workspaces"))).toEqual([]);
  });
  it("detects new sync tickets during the quiescent recovery fence and delegates them to the outbox", async () => {
    const e = await fixture();
    const work = await stage(e.cache, { "source.mp3": "source" });
    const recovery = recoverJobWorkspaces(e.cache);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(
      join(work.root, "local-sync-recovery.json"),
      "new durable ticket",
      { mode: 0o600 },
    );
    expect(await recovery).toEqual({ removed: 0, bytes: 0, preserved: 1 });
    expect(await readFile(join(work.root, "source.mp3"), "utf8")).toBe(
      "source",
    );
  });
  it.skipIf(process.platform === "win32")(
    "recovers an actual SIGKILL before a pair ticket exists, without model loading",
    async () => {
      const e = await fixture();
      const module = join(e.root, "workspace.mjs");
      await build({
        entryPoints: [
          join(import.meta.dirname, "../src/companion/job-workspace.ts"),
        ],
        outfile: module,
        bundle: true,
        platform: "node",
        format: "esm",
        logLevel: "silent",
      });
      const id = randomUUID();
      const root = join(e.cache, "jobs", id);
      await mkdir(root, { mode: 0o700 });
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { markJobWorkspace } from ${JSON.stringify(pathToFileURL(module).href)};
      import { writeFile } from 'node:fs/promises';
      await markJobWorkspace(${JSON.stringify(e.cache)},${JSON.stringify(id)});
      await writeFile(${JSON.stringify(join(root, "source.wav"))},'private app source',{mode:0o600});
      await writeFile(${JSON.stringify(join(root, "prepared.wav"))},'interrupted decode',{mode:0o600});
      process.stdout.write('ready');
      setInterval(()=>{},1000);
    `,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      try {
        const close = once(child, "close");
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error("CHILD_READY_TIMEOUT")),
            5000,
          );
          child.stdout.once("data", () => {
            clearTimeout(deadline);
            resolve();
          });
          child.once("error", (error) => {
            clearTimeout(deadline);
            reject(error);
          });
          child.once("exit", () => {
            clearTimeout(deadline);
            reject(new Error("CHILD_PREMATURE_EXIT"));
          });
        });
        child.kill("SIGKILL");
        await close;
        expect(await readdir(root)).toEqual(["prepared.wav", "source.wav"]);
        expect(await recoverJobWorkspaces(e.cache)).toMatchObject({
          removed: 1,
          preserved: 0,
        });
        expect(await readdir(join(e.cache, "jobs"))).toEqual([]);
        expect(await readdir(join(e.cache, "job-workspaces"))).toEqual([]);
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});
