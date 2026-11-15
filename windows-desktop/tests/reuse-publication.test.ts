import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  WindowsCommunityPublisher,
  parsePublicationRecord,
  type PublicationRecord,
  type PublicationStore,
  type PublicationMediaPort,
} from "../src/main/reuse/publication.js";
import { receiptFixture } from "./reuse-fixtures.js";
import type { CommunityContribution } from "../../chrome-extension/src/companion/youtube-community-client.js";
import { DesktopApiError } from "../../chrome-extension/src/companion/account-api.js";
function fixture(consumersAllowed?: () => boolean) {
  const f = receiptFixture(),
    records = new Map<string, PublicationRecord>(),
    owner = {
      sid: "S-1-5-21-100-200-300-1001",
      pid: 3000,
      creationTime: "100",
      sessionId: 1,
    };
  let time = Date.now(),
    serial: Promise<unknown> = Promise.resolve();
  const store: PublicationStore = {
    list: async () => [...records.values()].map((v) => structuredClone(v)),
    write: async (r) => {
      records.set(r.requestId, parsePublicationRecord(r));
    },
    mutate: (op) => {
      const task = serial.then(() =>
        op([...records.values()].map((v) => structuredClone(v))),
      );
      serial = task.catch(() => {});
      return task;
    },
  };
  const media: PublicationMediaPort = {
    pair: vi.fn(async () => f.pair),
    protect: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
    transfer: vi.fn(async () => {}),
  };
  const contribution = (
    requestId: string,
    state = "preparing",
  ): CommunityContribution => ({
    contribution_id: "0123456789abcdef01234567",
    request_id: requestId,
    video_id:
      f.pair.reuse!.source.kind === "youtube"
        ? f.pair.reuse!.source.videoId
        : "",
    profile_id: "kim-vocal-2-full-timeline-v1",
    state,
    producer: true,
    expires_at: new Date(time + 86400000).toISOString(),
    lease_expires_at: new Date(time + 600000).toISOString(),
    upload_grants: null,
  });
  const client = {
    reserve: vi.fn(
      async (_video: string, _signal: AbortSignal, requestId?: string) =>
        contribution(requestId!),
    ),
    uploadGrants: vi.fn(async (r: CommunityContribution) => ({
      ...r,
      state: "awaiting_upload",
      upload_grants: {
        original: { secret: "opaque" },
        vocals: { secret: "opaque" },
      },
    })),
    complete: vi.fn(async (r: CommunityContribution) => ({
      ...r,
      state: "ready",
      upload_grants: null,
    })),
    lookup: vi.fn(async () => ({}) as never),
    wait: vi.fn(async () => "ready" as const),
  };
  const options = {
    ...(consumersAllowed ? { consumersAllowed } : {}),
    store,
    media,
    client,
    now: () => time,
    identity: async () => owner,
    processIdentity: async () => owner,
  };
  return {
    f,
    records,
    store,
    media,
    client,
    options,
    advance: () => {
      time += 600000;
    },
    publisher: new WindowsCommunityPublisher(options),
  };
}
describe("Windows durable community publication", () => {
  it("starts no paused stage or drain and preserves first-play release for explicit resume", async () => {
    let allowed = true;
    const h = fixture(() => allowed),
      record = await h.publisher.stage(h.f.entry.personalJobId, true);
    allowed = false;
    await expect(h.publisher.stage(randomUUID(), true)).rejects.toThrow(
      "CONSUMERS_PAUSED",
    );
    await h.publisher.releasePlayback(record.jobId, record.vocalsSha256);
    await h.publisher.drain();
    await h.publisher.resume();
    expect(h.media.pair).toHaveBeenCalledOnce();
    expect(h.client.reserve).not.toHaveBeenCalled();
    expect(h.records.get(record.requestId)).toMatchObject({
      ready: false,
      state: "pending",
      attempts: 0,
    });
    expect(h.publisher.activity().idle).toBe(true);
    allowed = true;
    await h.publisher.resume();
    expect(h.records.get(record.requestId)?.state).toBe("committed");
    expect(h.media.transfer).toHaveBeenCalledOnce();
    await h.publisher.dispose();
  });
  it("keeps paused first-play proof when completion has not staged its pair yet", async () => {
    let allowed = false;
    const h = fixture(() => allowed);
    await h.publisher.releasePlayback(
      h.f.entry.personalJobId,
      h.f.entry.vocals.sha256,
    );
    allowed = true;
    await h.publisher.resume();
    expect(h.client.reserve).not.toHaveBeenCalled();
    const record = await h.publisher.stage(h.f.entry.personalJobId, true);
    expect(record.ready).toBe(true);
    await h.publisher.drain();
    expect(h.media.transfer).toHaveBeenCalledOnce();
    await h.publisher.dispose();
  });
  it("retains admitted stage activity through a paused metadata/copy promise", async () => {
    let allowed = true;
    const h = fixture(() => allowed);
    let finish!: (value: typeof h.f.pair) => void;
    h.media.pair = vi.fn(
      async () =>
        new Promise<typeof h.f.pair>((resolve) => {
          finish = resolve;
        }),
    );
    const stage = h.publisher.stage(h.f.entry.personalJobId, true);
    await vi.waitFor(() => expect(finish).toBeDefined());
    allowed = false;
    expect(h.publisher.activity().idle).toBe(false);
    await expect(h.publisher.stage(randomUUID(), true)).rejects.toThrow(
      "CONSUMERS_PAUSED",
    );
    finish(h.f.pair);
    const record = await stage;
    expect(h.records.get(record.requestId)?.state).toBe("pending");
    expect(h.publisher.activity().idle).toBe(true);
    expect(h.client.reserve).not.toHaveBeenCalled();
    await h.publisher.dispose();
  });
  it("lets a claimed publication finish but starts no second producer during maintenance", async () => {
    let allowed = true;
    const h = fixture(() => allowed),
      next = receiptFixture(),
      pairs = new Map([
        [h.f.entry.personalJobId, h.f.pair],
        [next.entry.personalJobId, next.pair],
      ]);
    h.media.pair = vi.fn(async (job) => pairs.get(job)!);
    const first = await h.publisher.stage(h.f.entry.personalJobId),
      second = await h.publisher.stage(next.entry.personalJobId);
    let finish!: (r: CommunityContribution) => void;
    h.client.reserve.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const run = h.publisher.drain();
    await vi.waitFor(() => expect(finish).toBeDefined());
    allowed = false;
    expect(h.publisher.drain()).toBe(run);
    expect(h.publisher.activity().idle).toBe(false);
    finish({
      contribution_id: null,
      request_id: first.producerRequestId,
      video_id: first.videoId,
      profile_id: "kim-vocal-2-full-timeline-v1",
      state: "ready",
      producer: false,
      expires_at: null,
      lease_expires_at: null,
      upload_grants: null,
    });
    await run;
    expect(h.records.get(first.requestId)?.state).toBe("committed");
    expect(h.records.get(second.requestId)).toMatchObject({
      state: "pending",
      attempts: 0,
      claim: null,
    });
    expect(h.client.reserve).toHaveBeenCalledOnce();
    allowed = true;
    await h.publisher.resume();
    expect(h.records.get(second.requestId)?.state).toBe("committed");
    await h.publisher.dispose();
  });
  it("counts stage and metadata lifetime immediately, emits activity, and disposal waits for the actual operation", async () => {
    const h = fixture(),
      activity = vi.fn(),
      off = h.publisher.subscribeActivity(activity);
    let release!: (value: typeof h.f.pair) => void;
    h.media.pair = vi.fn(
      async () =>
        new Promise<typeof h.f.pair>((resolve) => {
          release = resolve;
        }),
    );
    const stage = h.publisher.stage(h.f.entry.personalJobId, true);
    expect(h.publisher.activity()).toEqual({
      pending: 1,
      busy: true,
      idle: false,
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    let disposed = false;
    const disposal = h.publisher.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    await expect(h.publisher.snapshot(h.f.entry.personalJobId)).rejects.toThrow(
      "COMMUNITY_CLOSED",
    );
    release(h.f.pair);
    await stage;
    await disposal;
    expect(h.publisher.activity()).toEqual({
      pending: 0,
      busy: false,
      idle: true,
    });
    expect(activity.mock.calls.some(([state]) => state.busy === true)).toBe(
      true,
    );
    off();
  });
  it("reuses the pre-acquisition producer request and still blocks media PUT until playback", async () => {
    const h = fixture(),
      reserved = await h.client.reserve(
        "bZxrIoCPsOc",
        new AbortController().signal,
        "8dccf032-2b0f-48ee-86da-43f7c3898d42",
      ),
      row = await h.publisher.stage(h.f.entry.personalJobId, true, reserved);
    h.client.reserve.mockClear();
    await h.publisher.drain();
    expect(row.requestId).toBe(reserved.request_id);
    expect(row.producerRequestId).toBe(reserved.request_id);
    expect(h.client.reserve).not.toHaveBeenCalled();
    expect(h.media.transfer).not.toHaveBeenCalled();
    expect((await h.publisher.snapshot(row.jobId))?.declared).toBe(true);
    await h.publisher.dispose();
  });
  it("emits only after durable writes and exposes bounded state without grant or capability fields", async () => {
    const h = fixture(),
      changed = vi.fn(),
      off = h.publisher.subscribe(changed);
    expect(await h.publisher.snapshot(h.f.entry.personalJobId)).toBeNull();
    const row = await h.publisher.stage(h.f.entry.personalJobId, true);
    expect(changed).toHaveBeenLastCalledWith(row.jobId);
    const snapshot = await h.publisher.snapshot(row.jobId);
    expect(snapshot).toEqual({
      jobId: row.jobId,
      state: "pending",
      ready: false,
      declared: false,
      errorCode: null,
      attempts: 0,
      revision: 0,
      nextAttemptAt: null,
    });
    expect(Object.keys(snapshot!).sort()).toEqual([
      "attempts",
      "declared",
      "errorCode",
      "jobId",
      "nextAttemptAt",
      "ready",
      "revision",
      "state",
    ]);
    const calls = changed.mock.calls.length;
    off();
    await h.publisher.releasePlayback(row.jobId, row.vocalsSha256);
    expect(changed).toHaveBeenCalledTimes(calls);
    await h.publisher.dispose();
  });
  it("failed persistence cannot emit a fabricated publication state", async () => {
    const h = fixture(),
      changed = vi.fn();
    h.publisher.subscribe(changed);
    h.store.write = async () => {
      throw new Error("DISK_FULL");
    };
    await expect(
      h.publisher.stage(h.f.entry.personalJobId, true),
    ).rejects.toThrow("DISK_FULL");
    expect(changed).not.toHaveBeenCalled();
    expect(await h.publisher.snapshot(h.f.entry.personalJobId)).toBeNull();
    await h.publisher.dispose();
  });
  it("declares pending Chrome media without PUT until exact playback acknowledgement, coalesces concurrent drain", async () => {
    const h = fixture();
    const [a, b] = await Promise.all([
      h.publisher.stage(h.f.entry.personalJobId, true),
      h.publisher.stage(h.f.entry.personalJobId, true),
    ]);
    expect(a.requestId).toBe(b.requestId);
    await Promise.all([h.publisher.drain(), h.publisher.drain()]);
    expect(h.client.reserve).toHaveBeenCalledTimes(1);
    expect(h.media.transfer).not.toHaveBeenCalled();
    expect(h.records.get(a.requestId)?.declared).toBe(true);
    expect(JSON.stringify([...h.records.values()])).not.toContain("opaque");
    await expect(
      h.publisher.releasePlayback(a.jobId, "d".repeat(64)),
    ).rejects.toThrow("COMMUNITY_SOURCE_INVALID");
    await h.publisher.releasePlayback(a.jobId, a.vocalsSha256);
    await h.publisher.drain();
    expect(h.media.transfer).toHaveBeenCalledTimes(1);
    expect(h.records.get(a.requestId)?.state).toBe("committed");
    expect(await h.publisher.retainedDirectories()).toEqual(new Set());
    await h.publisher.dispose();
  });
  it("never publishes private files or previously shared/contributed media", async () => {
    const h = fixture();
    h.f.pair.reuse = {
      ...h.f.reuse,
      source: { kind: "file", inputBytes: 1, inputSha256: "a".repeat(64) },
    };
    await expect(h.publisher.stage(h.f.entry.personalJobId)).rejects.toThrow(
      "COMMUNITY_SOURCE_INVALID",
    );
    expect(h.client.reserve).not.toHaveBeenCalled();
    await h.publisher.dispose();
  });
  it("keeps stable persisted command identity after lost reservation response and confirms ambiguous PUT by completion", async () => {
    const h = fixture(),
      record = await h.publisher.stage(h.f.entry.personalJobId);
    h.client.reserve.mockRejectedValueOnce(
      new DesktopApiError("COMMUNITY_UNAVAILABLE", 503),
    );
    await h.publisher.drain();
    expect(h.records.get(record.requestId)?.state).toBe("pending");
    h.advance();
    h.media.transfer = vi.fn(async () => {
      throw new Error("UPLOAD_AMBIGUOUS");
    });
    await h.publisher.drain();
    expect(h.client.reserve.mock.calls.map((c) => c[2])).toEqual([
      record.producerRequestId,
      record.producerRequestId,
    ]);
    expect(h.records.get(record.requestId)?.state).toBe("committed");
    await h.publisher.dispose();
  });
  it("uses actual process birth claim to refuse concurrent publishers", async () => {
    const h = fixture(),
      record = await h.publisher.stage(h.f.entry.personalJobId);
    let finish!: (r: CommunityContribution) => void;
    h.client.reserve.mockImplementationOnce(
      async () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const active = h.publisher.drain();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const second = new WindowsCommunityPublisher(h.options);
    await second.drain();
    expect(h.client.reserve).toHaveBeenCalledTimes(1);
    finish({
      contribution_id: null,
      request_id: record.producerRequestId,
      video_id: record.videoId,
      profile_id: "kim-vocal-2-full-timeline-v1",
      state: "ready",
      producer: false,
      expires_at: null,
      lease_expires_at: null,
      upload_grants: null,
    });
    await active;
    await second.dispose();
    await h.publisher.dispose();
  });
  it("recovers a stale claim only after actual process birth no longer matches", async () => {
    const h = fixture(),
      record = await h.publisher.stage(h.f.entry.personalJobId);
    h.records.set(record.requestId, {
      ...record,
      claim: {
        owner: {
          sid: "S-1-5-21-100-200-300-1001",
          pid: 4000,
          creationTime: "obsolete",
          sessionId: 1,
        },
        nonce: "91c067e1-398c-4461-8de9-405a9339048e",
      },
    });
    await h.publisher.drain();
    expect(h.records.get(record.requestId)?.state).toBe("committed");
    expect(h.records.get(record.requestId)?.claim).toBeNull();
    await h.publisher.dispose();
  });
  it("rotates producer UUID only after known expired/not-found contribution while preserving prepared bytes", async () => {
    const h = fixture(),
      record = await h.publisher.stage(h.f.entry.personalJobId);
    h.client.uploadGrants.mockRejectedValueOnce(
      new DesktopApiError("YOUTUBE_CONTRIBUTION_EXPIRED", 410),
    );
    await h.publisher.drain();
    const renewed = h.records.get(record.requestId)!;
    expect(renewed.producerRequestId).not.toBe(record.producerRequestId);
    expect(renewed.jobId).toBe(record.jobId);
    expect(renewed.vocalsSha256).toBe(record.vocalsSha256);
    h.advance();
    await h.publisher.drain();
    expect(h.records.get(record.requestId)?.state).toBe("committed");
    await h.publisher.dispose();
  });
});
