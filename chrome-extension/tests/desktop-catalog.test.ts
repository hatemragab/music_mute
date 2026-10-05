import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopCatalog,
  type DesktopCatalogEntry,
} from "../src/companion/desktop-catalog.js";
import { MODEL_SHA256 } from "../src/companion/local-provider.js";
import {
  LocalSyncOutbox,
  type LocalLibraryOwner,
} from "../src/companion/sync-outbox.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function account(uid = "firebase-account-a"): LocalLibraryOwner {
  return { uid, session_generation: randomUUID() };
}
function namespace(uid: string): string {
  return createHash("sha256").update(uid).digest("hex");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mm-catalog-"));
  roots.push(root);
  const cache = join(root, "cache");
  const catalogRoot = join(root, "catalog");
  const owner = account();
  const catalog = new DesktopCatalog(catalogRoot, cache);
  async function audio(
    options: {
      owner?: string;
      guest?: boolean;
      youtube?: boolean;
      title?: string;
    } = {},
  ): Promise<DesktopCatalogEntry> {
    const key = createHash("sha256").update(randomUUID()).digest("hex");
    const directory = join(cache, "vocals", key);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const vocal = Buffer.from(`fixture voice ${key}`);
    const entry: DesktopCatalogEntry = {
      cache_key: key,
      operation_id: randomUUID(),
      source_kind: options.youtube ? "url" : "file",
      vocal_path: join(directory, "vocals.mp3"),
      duration_seconds: 10,
      bytes: vocal.length,
      sha256: createHash("sha256").update(vocal).digest("hex"),
      ...(options.youtube ? { video_id: "abcdefghijk" } : {}),
      ...(options.title ? { source_title: options.title } : {}),
    };
    await writeFile(entry.vocal_path, vocal, { mode: 0o600 });
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify({
        output_path: entry.vocal_path,
        duration_seconds: 10,
        source_duration_seconds: 10,
        bytes: entry.bytes,
        sha256: entry.sha256,
        model_id: MODEL_SHA256,
        trim_enabled: false,
        ...(!options.guest ? { owner_uid: options.owner ?? owner.uid } : {}),
        ...(options.youtube
          ? {
              source: {
                kind: "youtube",
                video_id: "abcdefghijk",
                format_id: "140",
                audio_track_id: null,
                audio_is_default: null,
                language: "en",
              },
            }
          : {}),
      }),
      { mode: 0o600 },
    );
    return entry;
  }
  async function retainedMetadata(
    entry: DesktopCatalogEntry,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const path = join(dirname(entry.vocal_path), "result.json");
    const metadata = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...metadata, ...fields }), {
      mode: 0o600,
    });
  }
  const manifestPath = join(catalogRoot, namespace(owner.uid), "entries.json");
  return {
    root,
    cache,
    catalogRoot,
    owner,
    catalog,
    audio,
    retainedMetadata,
    manifestPath,
  };
}

describe("durable account-owned desktop offline catalog", () => {
  it.each(["missing", "blank"])(
    "durably recovers a %s catalog title from the exact validated retained audio without changing recency",
    async (kind) => {
      const env = await fixture();
      const entry = await env.audio({
        youtube: true,
        ...(kind === "blank" ? { title: "   " } : {}),
      });
      await env.catalog.remember(env.owner, entry);
      const before = JSON.parse(await readFile(env.manifestPath, "utf8"));
      const audio = await readFile(entry.vocal_path);
      await env.retainedMetadata(entry, {
        source_title: "  Acquired\u0000 title\n  ",
      });
      const metadataPath = join(dirname(entry.vocal_path), "result.json");
      const metadata = await readFile(metadataPath);
      const page = await env.catalog.list(env.owner);
      expect(page.entries).toEqual([
        {
          ...before.entries[0],
          source_title: "Acquired title",
          vocal_path: entry.vocal_path,
        },
      ]);
      expect(page.entries[0]?.job_id).toBeUndefined();
      const recovered = JSON.parse(await readFile(env.manifestPath, "utf8"));
      expect(recovered.revision).not.toBe(before.revision);
      expect(recovered.entries).toEqual([
        { ...before.entries[0], source_title: "Acquired title" },
      ]);
      expect(
        (await new DesktopCatalog(env.catalogRoot, env.cache).list(env.owner))
          .entries,
      ).toEqual(page.entries);
      expect(await env.catalog.sourceTitle(env.owner, entry.cache_key)).toBe(
        "Acquired title",
      );
      expect(await readFile(entry.vocal_path)).toEqual(audio);
      expect(await readFile(metadataPath)).toEqual(metadata);
    },
  );

  it("preserves a meaningful saved title over a different acquired title without rewriting its revision", async () => {
    const env = await fixture();
    const entry = await env.audio({ title: "My saved name" });
    await env.catalog.remember(env.owner, entry);
    const before = await readFile(env.manifestPath);
    await env.retainedMetadata(entry, { source_title: "Acquired title" });
    expect((await env.catalog.list(env.owner)).entries[0]?.source_title).toBe(
      "My saved name",
    );
    expect(await readFile(env.manifestPath)).toEqual(before);
  });

  it.each([null, 42, true, [], { title: "untrusted" }, " \t\n\u0000"])(
    "ignores malformed optional retained title %j while preserving valid audio and catalog metadata",
    async (title) => {
      const env = await fixture();
      const entry = await env.audio();
      await env.catalog.remember(env.owner, entry);
      const before = await readFile(env.manifestPath);
      await env.retainedMetadata(entry, { source_title: title });
      const page = await env.catalog.list(env.owner);
      expect(page.total).toBe(1);
      expect(page.entries[0]?.source_title).toBeUndefined();
      expect(await readFile(env.manifestPath)).toEqual(before);
      expect(await readFile(entry.vocal_path)).toHaveLength(entry.bytes);
    },
  );

  it.each(["audio-hash", "output-path", "video", "private-owner"])(
    "never borrows a title from a retained result with a mismatched %s identity",
    async (kind) => {
      const env = await fixture();
      const entry = await env.audio({ youtube: true }),
        other = await env.audio({ youtube: true });
      await env.catalog.remember(env.owner, entry);
      await env.catalog.remember(env.owner, other);
      const before = await readFile(env.manifestPath);
      await env.retainedMetadata(other, { source_title: "Exact other title" });
      await env.retainedMetadata(entry, {
        source_title: "Ineligible title",
        ...(kind === "output-path" ? { output_path: other.vocal_path } : {}),
        ...(kind === "video"
          ? { source: { kind: "youtube", video_id: "11111111111" } }
          : {}),
        ...(kind === "private-owner"
          ? { owner_uid: "another-owner", account_job_id: "a".repeat(24) }
          : {}),
      });
      if (kind === "audio-hash")
        await writeFile(entry.vocal_path, Buffer.alloc(entry.bytes, 1), {
          mode: 0o600,
        });
      if (kind === "private-owner") {
        await expect(env.catalog.list(env.owner)).rejects.toThrow(
          "CATALOG_OWNER_MISMATCH",
        );
        expect(await readFile(env.manifestPath)).toEqual(before);
      } else {
        const page = await env.catalog.list(env.owner);
        expect(page.entries).toHaveLength(1);
        expect(page.entries[0]).toMatchObject({
          cache_key: other.cache_key,
          source_title: "Exact other title",
        });
        expect(await readFile(env.manifestPath, "utf8")).not.toContain(
          "Ineligible title",
        );
      }
      expect(await readFile(entry.vocal_path)).toHaveLength(entry.bytes);
    },
  );

  it("persists recovered metadata before rejecting an old cursor and keeps fresh pagination order stable", async () => {
    const env = await fixture();
    const first = await env.audio(),
      second = await env.audio();
    await env.catalog.remember(env.owner, first);
    await env.catalog.remember(env.owner, second);
    const ordered = (await env.catalog.list(env.owner)).entries;
    const page = await env.catalog.list(env.owner, undefined, 1);
    expect(page.next_cursor).toBeDefined();
    const before = JSON.parse(await readFile(env.manifestPath, "utf8"));
    await env.retainedMetadata(first, { source_title: "Recovered title" });
    await expect(
      env.catalog.list(env.owner, page.next_cursor, 1),
    ).rejects.toThrow("CATALOG_CURSOR_STALE");
    const after = JSON.parse(await readFile(env.manifestPath, "utf8"));
    expect(after.revision).not.toBe(before.revision);
    expect(after.entries).toEqual(
      before.entries.map((entry: DesktopCatalogEntry) =>
        entry.cache_key === first.cache_key
          ? { ...entry, source_title: "Recovered title" }
          : entry,
      ),
    );
    const fresh = await env.catalog.list(env.owner, undefined, 1);
    const following = await env.catalog.list(env.owner, fresh.next_cursor, 1);
    expect(
      [...fresh.entries, ...following.entries].map((entry) => entry.cache_key),
    ).toEqual(ordered.map((entry) => entry.cache_key));
    expect(await readFile(env.manifestPath, "utf8")).toBe(
      JSON.stringify(after),
    );
  });

  it("reads owner titles without modifying manifests or trusting missing audio for playback", async () => {
    const env = await fixture();
    const entry = await env.audio({ title: "My title" });
    await env.catalog.remember(env.owner, entry);
    const manifest = join(
      env.catalogRoot,
      namespace(env.owner.uid),
      "entries.json",
    );
    const before = await readFile(manifest);
    await rm(entry.vocal_path);
    expect(await env.catalog.sourceTitle(env.owner, entry.cache_key)).toBe(
      "My title",
    );
    expect(await readFile(manifest)).toEqual(before);
    expect(
      await env.catalog.sourceTitle(account("other-owner"), entry.cache_key),
    ).toBeUndefined();
    await expect(env.catalog.sourceTitle(env.owner, "invalid")).rejects.toThrow(
      "CATALOG_ENTRY_INVALID",
    );
  });
  it("rolls back only an exact owner cache key and digest association", async () => {
    const env = await fixture();
    const entry = await env.audio(),
      other = await env.audio();
    await env.catalog.remember(env.owner, entry);
    await env.catalog.remember(env.owner, other);
    await env.catalog.discard(
      account("other-owner"),
      entry.cache_key,
      entry.sha256,
    );
    await env.catalog.discard(env.owner, entry.cache_key, "f".repeat(64));
    expect((await env.catalog.list(env.owner)).total).toBe(2);
    await env.catalog.discard(env.owner, entry.cache_key, entry.sha256);
    expect(
      (await env.catalog.list(env.owner)).entries.map((item) => item.cache_key),
    ).toEqual([other.cache_key]);
    expect(await readFile(entry.vocal_path)).toHaveLength(entry.bytes);
  });
  it("returns bounded matching owner YouTube candidates without pruning or modifying audio metadata", async () => {
    const env = await fixture();
    const file = await env.audio(),
      youtube = await env.audio({ youtube: true });
    await env.catalog.remember(env.owner, file);
    await env.catalog.remember(env.owner, {
      ...youtube,
      job_id: "a".repeat(24),
    });
    const manifest = join(
      env.catalogRoot,
      namespace(env.owner.uid),
      "entries.json",
    );
    const before = await readFile(manifest);
    const matches = await env.catalog.youtubeCandidates(
      env.owner,
      "abcdefghijk",
      1,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      cache_key: youtube.cache_key,
      video_id: "abcdefghijk",
      job_id: "a".repeat(24),
    });
    expect(await readFile(manifest)).toEqual(before);
    expect(
      await env.catalog.youtubeCandidates(
        account("other-owner"),
        "abcdefghijk",
      ),
    ).toEqual([]);
    expect(
      await env.catalog.youtubeCandidates(env.owner, "different__"),
    ).toEqual([]);
    await expect(
      env.catalog.youtubeCandidates(env.owner, "invalid", 1),
    ).rejects.toThrow("CATALOG_PAGE_INVALID");
    await expect(
      env.catalog.youtubeCandidates(env.owner, "abcdefghijk", 33),
    ).rejects.toThrow("CATALOG_PAGE_INVALID");
  });
  it("preserves valid encoder padding at the maximum source duration", async () => {
    const env = await fixture();
    const entry = await env.audio();
    const path = join(dirname(entry.vocal_path), "result.json");
    const metadata = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({
        ...metadata,
        source_duration_seconds: 1800,
        duration_seconds: 1800.2,
        account_job_id: "a".repeat(24),
        model_id: "account-result",
      }),
      { mode: 0o600 },
    );
    await expect(
      env.catalog.remember(env.owner, { ...entry, duration_seconds: 1800.2 }),
    ).rejects.toThrow("CATALOG_ENTRY_INVALID");
    await expect(
      env.catalog.remember(env.owner, {
        ...entry,
        duration_seconds: 1800.26,
        source_duration_seconds: 1800,
      }),
    ).rejects.toThrow("CATALOG_ENTRY_INVALID");
    await env.catalog.remember(env.owner, {
      ...entry,
      duration_seconds: 1800.2,
      source_duration_seconds: 1800,
    });
    expect((await env.catalog.list(env.owner)).entries[0]).toMatchObject({
      duration_seconds: 1800.2,
      source_duration_seconds: 1800,
    });
  });
  it("accepts trusted trimmed account playback metadata without relabeling it as a synchronized full timeline", async () => {
    const env = await fixture();
    const entry = await env.audio();
    const path = join(dirname(entry.vocal_path), "result.json");
    const metadata = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({
        ...metadata,
        trim_enabled: true,
        source_duration_seconds: 1400,
        duration_seconds: 1200,
        account_job_id: "a".repeat(24),
        model_id: "account-result",
      }),
      { mode: 0o600 },
    );
    await expect(
      env.catalog.remember(env.owner, { ...entry, duration_seconds: 1200 }),
    ).rejects.toThrow("CATALOG_AUDIO_INVALID");
    await expect(
      env.catalog.remember(env.owner, {
        ...entry,
        duration_seconds: 1200,
        trim_enabled: true,
      }),
    ).rejects.toThrow("CATALOG_ENTRY_INVALID");
    await env.catalog.remember(env.owner, {
      ...entry,
      duration_seconds: 1200,
      source_duration_seconds: 1400,
      trim_enabled: true,
      job_id: "a".repeat(24),
    });
    expect((await env.catalog.list(env.owner)).entries[0]).toMatchObject({
      trim_enabled: true,
      duration_seconds: 1200,
      source_duration_seconds: 1400,
    });
  });
  it("never makes private account-downloaded YouTube results visible to another account through explicit association", async () => {
    const env = await fixture();
    const entry = await env.audio({ youtube: true });
    const path = join(dirname(entry.vocal_path), "result.json");
    const metadata = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({ ...metadata, account_job_id: "a".repeat(24) }),
      { mode: 0o600 },
    );
    await expect(
      env.catalog.remember(account("firebase-account-b"), entry),
    ).rejects.toThrow("CATALOG_OWNER_MISMATCH");
  });
  it("isolates guest and user libraries across account switches and returns only derived owned paths", async () => {
    const env = await fixture();
    const a = await env.audio({ title: "Original local title" });
    const guest = await env.audio({ guest: true });
    await env.catalog.remember(env.owner, a);
    await env.catalog.remember(undefined, guest);
    expect(
      (await env.catalog.list(env.owner)).entries.map(
        (entry) => entry.cache_key,
      ),
    ).toEqual([a.cache_key]);
    expect(
      (await env.catalog.list()).entries.map((entry) => entry.cache_key),
    ).toEqual([guest.cache_key]);
    expect(await env.catalog.list(account("firebase-account-b"))).toEqual({
      entries: [],
      total: 0,
    });
    const manifest = await readFile(
      join(env.catalogRoot, namespace(env.owner.uid), "entries.json"),
      "utf8",
    );
    expect(manifest).not.toContain("vocal_path");
    expect(manifest).not.toContain(env.cache);
    expect(JSON.parse(manifest).owner_uid).toBe(env.owner.uid);
    const restored = new DesktopCatalog(env.catalogRoot, env.cache);
    expect(
      (await restored.list({ ...env.owner, session_generation: randomUUID() }))
        .entries[0]?.job_id,
    ).toBeUndefined();
  });
  it("allows an explicit matching public YouTube association while refusing private file reuse under another account", async () => {
    const env = await fixture();
    const youtube = await env.audio({ youtube: true });
    const file = await env.audio();
    const b = account("firebase-account-b");
    await env.catalog.remember(env.owner, youtube);
    await env.catalog.remember(b, youtube);
    expect((await env.catalog.list(b)).entries[0]?.video_id).toBe(
      "abcdefghijk",
    );
    await expect(env.catalog.remember(b, file)).rejects.toThrow(
      "CATALOG_OWNER_MISMATCH",
    );
    await expect(
      env.catalog.remember(b, { ...youtube, video_id: "different__" }),
    ).rejects.toThrow("CATALOG_AUDIO_INVALID");
    expect(
      JSON.parse(
        await readFile(
          join(dirname(youtube.vocal_path), "result.json"),
          "utf8",
        ),
      ).owner_uid,
    ).toBe(env.owner.uid);
  });
  it("snapshots owner and declarations before asynchronous write admission", async () => {
    const env = await fixture();
    const entry = await env.audio();
    const originalUid = env.owner.uid;
    const accepted = env.catalog.remember(env.owner, entry);
    env.owner.uid = "firebase-account-b";
    entry.sha256 = "f".repeat(64);
    await accepted;
    expect(
      (await env.catalog.list({ ...env.owner, uid: originalUid })).total,
    ).toBe(1);
    expect((await env.catalog.list(env.owner)).total).toBe(0);
  });
  it("preserves the initial processing association during warm reuse and attaches server publication durably", async () => {
    const env = await fixture();
    const entry = await env.audio();
    await env.catalog.remember(env.owner, entry);
    const warm = await env.catalog.remember(env.owner, {
      ...entry,
      operation_id: randomUUID(),
    });
    expect(warm.operation_id).toBe(entry.operation_id);
    await env.catalog.attachJob(
      env.owner,
      entry.operation_id,
      "a".repeat(24),
      entry.sha256,
    );
    expect(
      (await new DesktopCatalog(env.catalogRoot, env.cache).list(env.owner))
        .entries[0]?.job_id,
    ).toBe("a".repeat(24));
    await expect(
      env.catalog.attachJob(
        env.owner,
        entry.cache_key,
        "b".repeat(24),
        "f".repeat(64),
      ),
    ).rejects.toThrow("CATALOG_ENTRY_CONFLICT");
    await expect(
      env.catalog.attachJob(
        account("firebase-account-b"),
        entry.cache_key,
        "a".repeat(24),
      ),
    ).rejects.toThrow("CATALOG_ENTRY_MISSING");
  });
  it("survives bounded outbox receipt rotation without losing offline ownership or the server job association", async () => {
    const env = await fixture();
    const entry = await env.audio();
    await env.catalog.remember(env.owner, entry);
    const originalRoot = join(env.cache, "jobs", randomUUID());
    await mkdir(originalRoot, { recursive: true, mode: 0o700 });
    const original = join(originalRoot, "source.mp3");
    await writeFile(original, "fixture original", { mode: 0o600 });
    const outbox = new LocalSyncOutbox(join(env.root, "outbox"), env.cache, {
      max_records: 1,
      minimum_free_bytes: 0,
    });
    const staged = await outbox.stage({
      owner: env.owner,
      request_id: entry.operation_id,
      cache_key: entry.cache_key,
      original: {
        path: original,
        duration_seconds: 10,
        bytes: 16,
        extension: "mp3",
        content_type: "audio/mpeg",
        sha256: createHash("sha256").update("fixture original").digest("hex"),
      },
      vocals: {
        path: entry.vocal_path,
        duration_seconds: 10,
        bytes: entry.bytes,
        extension: "mp3",
        content_type: "audio/mpeg",
        sha256: entry.sha256,
      },
    });
    const attempt = await outbox.beginAttempt(env.owner, staged.request_id);
    const jobId = "a".repeat(24);
    await outbox.commit(
      env.owner,
      staged.request_id,
      { sync_id: randomUUID(), job_id: jobId, committed: true },
      attempt.attempt_id!,
    );
    await env.catalog.attachJob(
      env.owner,
      entry.cache_key,
      jobId,
      entry.sha256,
    );
    await outbox.assertAdmission(1);
    expect(await outbox.associations(env.owner)).toEqual([]);
    const [retained] = (await env.catalog.list(env.owner)).entries;
    expect(retained?.job_id).toBe(jobId);
    expect(retained?.cache_key).toBe(entry.cache_key);
    expect(await readFile(entry.vocal_path)).toHaveLength(entry.bytes);
  });
  it("prunes evicted or corrupted metadata without deleting media and never expires active vocals based on age", async () => {
    const env = await fixture();
    const old = await env.audio();
    const evicted = await env.audio();
    const corrupt = await env.audio();
    for (const entry of [old, evicted, corrupt])
      await env.catalog.remember(env.owner, entry);
    const timestamp = new Date(Date.now() - 100 * 24 * 60 * 60_000);
    await utimes(dirname(old.vocal_path), timestamp, timestamp);
    await rm(dirname(evicted.vocal_path), { recursive: true });
    await writeFile(corrupt.vocal_path, "corruption", { mode: 0o600 });
    const page = await env.catalog.list(env.owner);
    expect(page.entries.map((entry) => entry.cache_key)).toEqual([
      old.cache_key,
    ]);
    expect(await readFile(corrupt.vocal_path, "utf8")).toBe("corruption");
    expect(
      JSON.parse(
        await readFile(
          join(env.catalogRoot, namespace(env.owner.uid), "entries.json"),
          "utf8",
        ),
      ).entries,
    ).toHaveLength(1);
  });
  it("recovers interrupted metadata writes and preserves the last published manifest and unrelated files", async () => {
    const env = await fixture();
    const entry = await env.audio();
    await env.catalog.remember(env.owner, entry);
    const accountRoot = join(env.catalogRoot, namespace(env.owner.uid));
    const temporary = join(accountRoot, `.entries-${randomUUID()}.tmp`);
    await writeFile(temporary, '{"partial":', { mode: 0o600 });
    await writeFile(join(accountRoot, "keep.txt"), "user-owned keep", {
      mode: 0o600,
    });
    await env.catalog.recover(env.owner);
    expect(await readdir(accountRoot)).toEqual(
      expect.arrayContaining(["entries.json", "keep.txt"]),
    );
    await expect(readFile(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await env.catalog.list(env.owner)).total).toBe(1);
  });
  it.each(["external-path", "symlink", "hardlink", "permissions"])(
    "refuses unsafe %s cache artifacts without deleting bytes",
    async (mode) => {
      const env = await fixture();
      const entry = await env.audio();
      if (mode === "external-path")
        entry.vocal_path = join(env.root, "outside.mp3");
      else if (mode === "symlink") {
        const content = await readFile(entry.vocal_path);
        await rm(entry.vocal_path);
        const outside = join(env.root, "outside.mp3");
        await writeFile(outside, content, { mode: 0o600 });
        await symlink(outside, entry.vocal_path);
      } else if (mode === "hardlink")
        await link(entry.vocal_path, join(env.root, "linked.mp3"));
      else await chmod(entry.vocal_path, 0o644);
      await expect(env.catalog.remember(env.owner, entry)).rejects.toThrow(
        /CATALOG_(ENTRY_INVALID|UNSAFE)/,
      );
    },
  );
  it("rejects corrupt or unexpected metadata fields without overwriting the manifest", async () => {
    const env = await fixture();
    const entry = await env.audio();
    await env.catalog.remember(env.owner, entry);
    const path = join(
      env.catalogRoot,
      namespace(env.owner.uid),
      "entries.json",
    );
    const before = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({
        ...before,
        grant: "https://private.invalid/?token=secret",
      }),
      { mode: 0o600 },
    );
    const corrupt = await readFile(path);
    await expect(env.catalog.list(env.owner)).rejects.toThrow(
      "CATALOG_MANIFEST_INVALID",
    );
    await expect(env.catalog.remember(env.owner, entry)).rejects.toThrow(
      "CATALOG_MANIFEST_INVALID",
    );
    expect(await readFile(path)).toEqual(corrupt);
  });
  it("bounds Unicode page replies and scopes cursors to one account and revision", async () => {
    const env = await fixture();
    for (let i = 0; i < 55; i++)
      await env.catalog.remember(
        env.owner,
        await env.audio({ title: "ح".repeat(300) }),
      );
    const first = await env.catalog.list(env.owner, undefined, 50);
    expect(first.total).toBe(55);
    expect(first.entries.length).toBeGreaterThan(0);
    expect(first.next_cursor).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(64 * 1024);
    const second = await env.catalog.list(env.owner, first.next_cursor, 50);
    const keys = [...first.entries, ...second.entries].map(
      (entry) => entry.cache_key,
    );
    expect(new Set(keys).size).toBe(keys.length);
    await expect(
      env.catalog.list(account("firebase-account-b"), first.next_cursor),
    ).rejects.toThrow("CATALOG_CURSOR_INVALID");
    await env.catalog.remember(env.owner, await env.audio());
    await expect(
      env.catalog.list(env.owner, first.next_cursor),
    ).rejects.toThrow("CATALOG_CURSOR_STALE");
    await expect(env.catalog.list(env.owner, undefined, 51)).rejects.toThrow(
      "CATALOG_PAGE_INVALID",
    );
  }, 15000);
});
