import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountApiClient } from "../src/companion/account-api.js";
import {
  LocalPairSyncClient,
  validateUploadGrant,
} from "../src/companion/local-sync-client.js";
import { LocalSyncOutbox } from "../src/companion/sync-outbox.js";
import type { LocalAudioArtifact } from "../src/shared/protocol.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mm-pair-wire-"));
  roots.push(root);
  const cache = join(root, "cache"),
    work = join(cache, "jobs", randomUUID()),
    key = createHash("sha256").update(randomUUID()).digest("hex"),
    voices = join(cache, "vocals", key);
  await mkdir(work, { recursive: true, mode: 0o700 });
  await mkdir(voices, { recursive: true, mode: 0o700 });
  const artifact = async (
    path: string,
    text: string,
  ): Promise<LocalAudioArtifact> => {
    await writeFile(path, text, { mode: 0o600 });
    return {
      path,
      extension: "mp3",
      content_type: "audio/mpeg",
      duration_seconds: 10,
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    };
  };
  const original = await artifact(join(work, "original.mp3"), "original"),
    vocals = await artifact(join(voices, "vocals.mp3"), "voices");
  const session = {
    firebase_uid: "account-a",
    session_generation: randomUUID(),
    installation_id: randomUUID(),
    id_token: "header.payload.signature",
  };
  const owner = {
    uid: session.firebase_uid,
    session_generation: session.session_generation,
  };
  const outbox = new LocalSyncOutbox(join(root, "outbox"), cache, {
    minimum_free_bytes: 0,
  });
  const staged = await outbox.stage({
    owner,
    request_id: randomUUID(),
    cache_key: key,
    original,
    vocals,
  });
  const grant = (item: LocalAudioArtifact) => ({
    method: "PUT",
    url: `https://fixture.r2.cloudflarestorage.com/${item === original ? "original" : "vocals"}?signed=private`,
    expires_at: new Date(Date.now() + 300000).toISOString(),
    headers: {
      "Content-Type": item.content_type,
      "If-None-Match": "*",
      "x-amz-checksum-sha256": Buffer.from(item.sha256, "hex").toString(
        "base64",
      ),
      "x-amz-meta-sha256": Buffer.from(item.sha256, "hex").toString("base64"),
    },
  });
  const view = (ready = false) => ({
    sync_id: "a".repeat(24),
    job_id: "b".repeat(24),
    request_id: staged.request_id,
    profile_id: "kim-vocal-2-full-timeline-v1",
    status: ready ? "ready" : "awaiting_upload",
    committed: ready,
    upload_grants: ready
      ? null
      : { original: grant(original), vocals: grant(vocals) },
  });
  let current = true;
  const fetched = vi
    .fn()
    .mockImplementation(async (_url: URL, _options: RequestInit) =>
      json(view()),
    );
  const api = new AccountApiClient(
    "https://api.music-mute.com",
    async () => session,
    () => current,
    fetched,
  );
  return {
    root,
    session,
    owner,
    staged,
    outbox,
    original,
    vocals,
    grant,
    view,
    fetched,
    api,
    changeAccount: () => {
      current = false;
    },
  };
}
describe("local pair account transfer", () => {
  it("uploads immutable originals and vocals without a bearer and deletes originals only after receipt", async () => {
    const e = await fixture();
    e.fetched
      .mockResolvedValueOnce(json(e.view()))
      .mockResolvedValueOnce(json(e.view(true)));
    const transfer = vi
      .fn()
      .mockImplementation(async (_url: string, options: RequestInit) => {
        for await (const _chunk of options.body as unknown as AsyncIterable<Uint8Array>) {
          /* consume bounded FD */
        }
        return new Response(null, { status: 200 });
      });
    const result = await new LocalPairSyncClient(
      e.api,
      e.outbox,
      transfer,
    ).savePending(e.session);
    expect(result).toEqual([
      {
        request_id: e.staged.request_id,
        cache_key: e.staged.cache_key,
        state: "ready",
        job_id: "b".repeat(24),
      },
    ]);
    expect(transfer).toHaveBeenCalledTimes(2);
    const options = transfer.mock.calls[0]![1];
    expect(options.redirect).toBe("error");
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers["If-None-Match"]).toBe("*");
    expect(JSON.parse(e.fetched.mock.calls[0]![1].body)).toMatchObject({
      profile_id: "kim-vocal-2-full-timeline-v1",
      original: {
        sha256: Buffer.from(e.original.sha256, "hex").toString("base64"),
      },
    });
    await expect(readFile(e.staged.original.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(e.staged.vocals.path, "utf8")).toBe("voices");
  });
  it("treats a conditional PUT conflict as requiring server verification", async () => {
    const e = await fixture();
    e.fetched
      .mockResolvedValueOnce(json(e.view()))
      .mockResolvedValueOnce(json({ code: "UPLOAD_NOT_READY" }, 409));
    const result = await new LocalPairSyncClient(
      e.api,
      e.outbox,
      vi.fn().mockResolvedValue(new Response(null, { status: 412 })),
    ).savePending(e.session);
    expect(result[0]?.state).toBe("failed");
    expect(await readFile(e.staged.original.path, "utf8")).toBe("original");
    expect(await e.outbox.pinnedCacheKeys()).toContain(e.staged.cache_key);
  });
  it("recovers an ambiguous transfer using one completion command without repeating PUT", async () => {
    const e = await fixture();
    e.fetched
      .mockResolvedValueOnce(json(e.view()))
      .mockResolvedValueOnce(json(e.view(true)));
    const transfer = vi
      .fn()
      .mockRejectedValue(new Error("private transfer receipt lost"));
    expect(
      (
        await new LocalPairSyncClient(e.api, e.outbox, transfer).savePending(
          e.session,
        )
      )[0]?.state,
    ).toBe("ready");
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(e.fetched).toHaveBeenCalledTimes(2);
  });
  it("fences logout before completion and keeps the pending pair", async () => {
    const e = await fixture();
    const transfer = vi.fn().mockImplementation(async () => {
      e.changeAccount();
      return new Response(null, { status: 200 });
    });
    const result = await new LocalPairSyncClient(
      e.api,
      e.outbox,
      transfer,
    ).savePending(e.session);
    expect(result[0]?.error_code).toBe("ACCOUNT_CHANGED");
    expect(e.fetched).toHaveBeenCalledTimes(1);
    expect(await readFile(e.staged.original.path, "utf8")).toBe("original");
  });
  it("reuses a completed idempotency receipt without any file upload", async () => {
    const e = await fixture();
    e.fetched.mockResolvedValue(json(e.view(true)));
    const transfer = vi.fn();
    expect(
      (
        await new LocalPairSyncClient(e.api, e.outbox, transfer).savePending(
          e.session,
        )
      )[0]?.state,
    ).toBe("ready");
    expect(transfer).not.toHaveBeenCalled();
  });
  it("refuses grant host, checksum, header or expiration changes", async () => {
    const e = await fixture();
    for (const changed of [
      { ...e.grant(e.original), url: "https://evil.test/upload" },
      { ...e.grant(e.original), url: "not a url" },
      {
        ...e.grant(e.original),
        headers: { ...e.grant(e.original).headers, Authorization: "private" },
      },
      {
        ...e.grant(e.original),
        headers: {
          ...e.grant(e.original).headers,
          "x-amz-meta-sha256": "wrong",
        },
      },
      {
        ...e.grant(e.original),
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    ])
      expect(() => validateUploadGrant(changed, e.original)).toThrow();
  });
});
