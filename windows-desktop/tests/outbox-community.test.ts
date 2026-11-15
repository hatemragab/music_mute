import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WindowsOutboxCommunity } from "../src/main/outbox/community.js";
import { stageOutbox } from "../src/main/outbox/model.js";
import {
  FULL_TIMELINE_RECIPE_DIGEST,
  type RealtimeAccess,
} from "../../chrome-extension/src/companion/cloud-provider.js";
import { localEntry, outboxInstallation, jobId } from "./outbox-fixtures.js";
import { ownerA } from "./realtime-fixtures.js";
function fixture(hit = true) {
  const entry = localEntry(true),
    record = stageOutbox(
      entry,
      ownerA,
      outboxInstallation,
      randomUUID(),
      "community-link",
      Date.now(),
    );
  let current = true;
  const job = {
    id: jobId,
    request_id: randomUUID(),
    status: "ready",
    processing_origin: "cloud",
    source_kind: "url",
    source_url: "https://www.youtube.com/watch?v=bZxrIoCPsOc",
    trim_enabled: false,
    recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
    can_download_input: true,
    can_download_output: true,
    input: {
      extension: "m4a",
      content_type: "audio/mp4",
      bytes: 1000,
      duration_seconds: 60,
      sha256: Buffer.from("b".repeat(64), "hex").toString("base64"),
    },
    output: {
      extension: "mp3",
      content_type: "audio/mpeg",
      bytes: record.vocals.bytes,
      duration_seconds: 60,
      sha256: Buffer.from(record.vocals.sha256, "hex").toString("base64"),
    },
    error: null,
  };
  const account = {
      sessionScope: () => ownerA,
      assertScope: () => {
        if (!current) throw new Error("ACCOUNT_CHANGED");
      },
      authorization: async () => "header.payload.synthetic-private",
    },
    rt: RealtimeAccess = {
      start: vi.fn(),
      stop: vi.fn(),
      onState: () => () => {},
      read: vi.fn(async () => ({ items: hit ? [job] : [], next_cursor: null })),
      watch: vi.fn((_resource, _params, listener) => {
        queueMicrotask(() => listener({ data: job }));
        return () => {};
      }),
    },
    fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        import_id: "0123456789abcdef01234569",
        status: "submitted",
        job_id: jobId,
        error: null,
      }),
    ),
    community = new WindowsOutboxCommunity({
      origin: "https://api.example.test",
      installationId: outboxInstallation,
      account,
      realtime: { cloudLease: () => rt },
      fetch: fetcher,
    });
  return {
    community,
    record,
    job,
    account,
    rt,
    fetcher,
    changed: () => {
      current = false;
    },
  };
}
describe("existing ready community owner delivery", () => {
  it("reuses exact current-account full-timeline output with no backend intake", async () => {
    const f = fixture();
    expect(
      await f.community.link(f.record, ownerA, new AbortController().signal),
    ).toBe(jobId);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.rt.stop).toHaveBeenCalledOnce();
  });
  it("keeps the durable request UUID when ready shared delivery is explicitly retried", async () => {
    const f = fixture(false);
    for (let i = 0; i < 2; i++)
      expect(
        await f.community.link(f.record, ownerA, new AbortController().signal),
      ).toBe(jobId);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of f.fetcher.mock.calls) {
      expect(String(url)).toBe(
        "https://api.example.test/media-imports/cache-deliveries",
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        request_id: f.record.requestId,
        trim_enabled: false,
      });
    }
    expect(f.rt.stop).toHaveBeenCalledTimes(2);
  });
  it("rejects wrong output identity and late account snapshots before Library association", async () => {
    const wrong = fixture();
    wrong.job.output.sha256 = Buffer.alloc(32, 9).toString("base64");
    await expect(
      wrong.community.link(wrong.record, ownerA, new AbortController().signal),
    ).rejects.toThrow("SOURCE_IDENTITY_MISMATCH");
    const old = fixture();
    vi.mocked(old.rt.read).mockImplementationOnce(async () => {
      old.changed();
      return { items: [old.job], next_cursor: null };
    });
    await expect(
      old.community.link(old.record, ownerA, new AbortController().signal),
    ).rejects.toThrow();
    expect(old.fetcher).not.toHaveBeenCalled();
  });
});
