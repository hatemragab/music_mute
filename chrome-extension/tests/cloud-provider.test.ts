import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudProcessingProvider,
  FULL_TIMELINE_PROFILE_ID,
  FULL_TIMELINE_RECIPE_DIGEST,
  fullTimeline,
  parseJobMetadata,
  type CloudProgress,
  type RealtimeAccess,
} from "../src/companion/cloud-provider.js";
import {
  DesktopApiError,
  CloudReplyValidationError,
  type AccountScope,
} from "../src/companion/account-api.js";
import {
  type AccountResource,
  type AccountSnapshot,
  type AccountTransport,
} from "../src/companion/account-realtime.js";

const scope: AccountScope = {
  firebase_uid: "owner-a",
  session_generation: "38b8e310-4805-42f2-b065-447b031c542e",
};
const requestId = "9c434f91-4e73-4bb5-8fe2-cb186284f54a";
const jobId = "0123456789abcdef01234567",
  importId = "0123456789abcdef01234568";
const url = "https://www.youtube.com/watch?v=bZxrIoCPsOc";
const hash = Buffer.alloc(32, 1).toString("base64");
const input = {
  extension: "m4a",
  content_type: "audio/mp4",
  bytes: 1000,
  duration_seconds: 60,
  sha256: hash,
};
const job = (overrides: Record<string, unknown> = {}) => ({
  id: jobId,
  request_id: requestId,
  status: "ready",
  source_kind: "url",
  source_url: url,
  recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
  trim_enabled: false,
  can_download_input: true,
  can_download_output: true,
  input,
  output: {
    extension: "mp3",
    content_type: "audio/mpeg",
    bytes: 500,
    duration_seconds: null,
    sha256: hash,
  },
  error: null,
  ...overrides,
});
const imported = (status = "queued", id: string | null = null) => ({
  import_id: importId,
  status,
  job_id: id,
  error: null,
});
const grant = () => ({
  url: "https://abc.r2.cloudflarestorage.com/private?signature=secret",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
});
class Realtime implements RealtimeAccess {
  listeners = new Map<string, (value: AccountSnapshot) => void>();
  start = vi.fn();
  stop = vi.fn();
  read = vi.fn<RealtimeAccess["read"]>();
  onState: RealtimeAccess["onState"] = () => () => {};
  watch(
    resource: AccountResource,
    params: Record<string, string>,
    listener: (value: AccountSnapshot) => void,
  ) {
    const key = `${resource}:${params.id}`;
    this.listeners.set(key, listener);
    return () => {
      this.listeners.delete(key);
    };
  }
  emit(resource: AccountResource, id: string, data: unknown) {
    this.listeners.get(`${resource}:${id}`)?.({ data });
  }
}
const providers: CloudProcessingProvider[] = [];
afterEach(() => {
  for (const provider of providers.splice(0)) provider.close();
});
function harness(handler?: (path: string, body: unknown) => Promise<unknown>) {
  let current = true;
  const request = vi
    .fn<AccountTransport["request"]>()
    .mockImplementation(async (_scope, path, method, body) => {
      expect(method).toBe("POST");
      if (handler) return handler(path, body);
      if (path === "/media-imports") return imported();
      if (path === "/media-imports/cache-deliveries")
        throw new DesktopApiError("IMPORT_CACHE_MISS", 404);
      if (path.endsWith("/download-grants")) return grant();
      if (path.endsWith("/cancellations"))
        return { id: jobId, status: "cancel_requested" };
      throw new Error("private unsupported request");
    });
  const api: AccountTransport = {
    origin: "https://api.music-mute.com",
    request,
    assertCurrent(candidate) {
      if (
        !current ||
        candidate.firebase_uid !== scope.firebase_uid ||
        candidate.session_generation !== scope.session_generation
      )
        throw new DesktopApiError("ACCOUNT_CHANGED");
    },
  };
  const realtime = new Realtime();
  const progress: CloudProgress[] = [];
  const resolveDownload = vi.fn().mockResolvedValue(undefined);
  const provider = new CloudProcessingProvider({
    api,
    scope,
    realtime,
    onProgress: (value) => progress.push(value),
    resolveDownload,
  });
  providers.push(provider);
  return {
    api,
    request,
    realtime,
    progress,
    resolveDownload,
    provider,
    changeOwner() {
      current = false;
    },
  };
}
async function flush() {
  for (let count = 0; count < 5; count++) await Promise.resolve();
}
describe("explicit native cloud provider", () => {
  it.each([
    "https://www.youtube.com/watch?v=bZxrIoCPsOc&list=RDbZxrIoCPsOc&start_radio=1",
    "https://youtu.be/bZxrIoCPsOc?si=RLbbOevlM4lBmXHi",
  ])(
    "submits the same canonical video identity for alias %s",
    async (alias) => {
      const h = harness(async (path) =>
        path === "/media-imports" ? imported("submitted", jobId) : grant(),
      );
      const result = h.provider.startYouTube({
        url: alias,
        request_id: requestId,
      });
      await vi.waitFor(() =>
        expect(h.realtime.listeners.has(`job:${jobId}`)).toBe(true),
      );
      expect(h.request.mock.calls[0]?.slice(1, 4)).toEqual([
        "/media-imports",
        "POST",
        { url, request_id: requestId, trim_enabled: false },
      ]);
      h.realtime.emit("job", jobId, job());
      expect((await result).job.source_url).toBe(url);
      expect(h.request).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    "https://www.youtube.com/watch?list=RDbZxrIoCPsOc",
    "https://www.youtube.com/watch?v=bZxrIoCPsOc&v=abcdefghijk",
    "https://youtu.be/bZxrIoCPsOc?v=abcdefghijk",
    "https://user@www.youtube.com/watch?v=bZxrIoCPsOc",
    "https://www.youtube.com:443/watch?v=bZxrIoCPsOc",
    "https://www.youtube.com/watch?v=bZxrIoCPsOc#t=30",
    "https://www.youtube.com.evil.example/watch?v=bZxrIoCPsOc",
  ])(
    "rejects ambiguous cloud video references before API work %s",
    async (alias) => {
      const h = harness();
      await expect(
        h.provider.startYouTube({ url: alias, request_id: requestId }),
      ).rejects.toMatchObject({ code: "INVALID_VIDEO_ID" });
      expect(h.request).not.toHaveBeenCalled();
      expect(h.realtime.start).not.toHaveBeenCalled();
    },
  );
  it("does no account/cloud work until explicitly started, then follows import and job snapshots", async () => {
    const h = harness();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.realtime.start).not.toHaveBeenCalled();
    const result = h.provider.startYouTube({ url, request_id: requestId });
    await flush();
    expect(h.request.mock.calls[0]?.slice(1, 4)).toEqual([
      "/media-imports",
      "POST",
      { url, request_id: requestId, trim_enabled: false },
    ]);
    h.realtime.emit("import", importId, imported("submitted", jobId));
    await flush();
    h.realtime.emit(
      "job",
      jobId,
      job({ status: "processing", can_download_output: false, output: null }),
    );
    h.realtime.emit("job", jobId, job());
    const value = await result;
    expect(value.job.id).toBe(jobId);
    expect(value.download_grant).toBeUndefined();
    expect(value.job.output?.duration_seconds).toBeNull();
    expect(h.resolveDownload).toHaveBeenCalledOnce();
    expect(h.request.mock.calls.every((call) => call[2] === "POST")).toBe(true);
    expect(JSON.stringify(h.progress)).not.toContain("signature");
    expect(JSON.stringify(h.progress)).not.toContain(url);
    expect(h.realtime.listeners.size).toBe(0);
  });
  it("passes a cloud quota failure through once with no local fallback or repeated creation", async () => {
    const h = harness(async () => {
      throw new DesktopApiError("PROCESSING_ALLOWANCE_EXHAUSTED", 429);
    });
    await expect(
      h.provider.startYouTube({ url, request_id: requestId }),
    ).rejects.toMatchObject({ code: "PROCESSING_ALLOWANCE_EXHAUSTED" });
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.resolveDownload).not.toHaveBeenCalled();
    expect(h.realtime.listeners.size).toBe(0);
  });
  it("does not retry an ambiguous paid creation or expose private exception text", async () => {
    const h = harness(async () => {
      throw new DesktopApiError("API_UNAVAILABLE");
    });
    await expect(
      h.provider.startYouTube({ url, request_id: requestId }),
    ).rejects.toMatchObject({ message: "API_UNAVAILABLE" });
    expect(h.request).toHaveBeenCalledOnce();
  });
  it("fences a late account snapshot before downloads or progress reach another account", async () => {
    const h = harness();
    const result = h.provider.startYouTube({ url, request_id: requestId });
    const rejection = expect(result).rejects.toMatchObject({
      code: "ACCOUNT_CHANGED",
    });
    await flush();
    h.changeOwner();
    h.realtime.emit("import", importId, imported("submitted", jobId));
    await rejection;
    expect(h.resolveDownload).not.toHaveBeenCalled();
    expect(h.request).toHaveBeenCalledOnce();
  });
  it("cancels a known job and cleans waiting subscribers even if the command fails", async () => {
    const h = harness();
    const result = h.provider.startYouTube({ url, request_id: requestId });
    const rejection = expect(result).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await flush();
    h.realtime.emit("import", importId, imported("submitted", jobId));
    await flush();
    await h.provider.cancel();
    await rejection;
    expect(h.request.mock.calls.at(-1)?.slice(1, 4)).toEqual([
      `/jobs/${jobId}/cancellations`,
      "POST",
      {},
    ]);
    expect(h.realtime.listeners.size).toBe(0);
  });
  it("stops early import waiting without inventing an import cancellation route", async () => {
    const h = harness();
    const result = h.provider.startYouTube({ url, request_id: requestId });
    const rejection = expect(result).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await flush();
    await h.provider.cancel();
    await rejection;
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.realtime.listeners.size).toBe(0);
  });
  it.each([
    { trim_enabled: true },
    { recipe_digest: "0".repeat(64) },
    { source_url: "https://www.youtube.com/watch?v=abcdefghijk" },
    {
      output: {
        extension: "mp3",
        content_type: "audio/mpeg",
        bytes: 500,
        sha256: hash,
        duration_seconds: 45,
      },
    },
  ])("refuses incompatible timeline/source metadata %j", async (overrides) => {
    const h = harness(async (path) =>
      path === "/media-imports" ? imported("submitted", jobId) : grant(),
    );
    const result = h.provider.startYouTube({ url, request_id: requestId });
    const rejection = expect(result).rejects.toMatchObject({
      code: "TIMELINE_INCOMPATIBLE",
    });
    await flush();
    h.realtime.emit("job", jobId, job(overrides));
    await rejection;
    expect(h.resolveDownload).not.toHaveBeenCalled();
    expect(h.request).toHaveBeenCalledOnce();
  });
  it("looks for eligible owned Library results through bounded socket pages before requesting a grant", async () => {
    const h = harness();
    h.realtime.read
      .mockResolvedValueOnce({
        items: [job({ trim_enabled: true })],
        next_cursor: "page2",
      })
      .mockResolvedValueOnce({
        items: [
          job({
            processing_origin: "local_device",
            local_profile_id: FULL_TIMELINE_PROFILE_ID,
          }),
        ],
        next_cursor: null,
      });
    const found = await h.provider.findReusableYouTube("bZxrIoCPsOc");
    expect(found?.id).toBe(jobId);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.realtime.read).toHaveBeenCalledTimes(2);
    expect(h.realtime.read.mock.calls[1]?.[1]).toEqual({
      limit: "50",
      status: "ready",
      cursor: "page2",
    });
    h.realtime.read.mockResolvedValue(job());
    await h.provider.downloadJob(jobId);
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.resolveDownload).toHaveBeenCalledOnce();
  });
  it("bounds lookup cursor cycles and scope changes", async () => {
    const h = harness();
    h.realtime.read.mockResolvedValue({ items: [], next_cursor: "same" });
    await expect(
      h.provider.findReusableYouTube("bZxrIoCPsOc"),
    ).rejects.toMatchObject({ code: "CLOUD_REPLY_INVALID" });
    expect(h.realtime.read).toHaveBeenCalledTimes(2);
    h.changeOwner();
    await expect(
      h.provider.findReusableYouTube("bZxrIoCPsOc"),
    ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
  });
  it("delivers another account's shared YouTube result after an owner miss without starting cloud work", async () => {
    const deliveredJobId = "fedcba9876543210fedcba98";
    const h = harness(async (path) => {
      expect(path).toBe("/media-imports/cache-deliveries");
      return imported("submitted", deliveredJobId);
    });
    h.realtime.read.mockResolvedValue({ items: [], next_cursor: null });
    const result = h.provider.findReusableYouTube("bZxrIoCPsOc", 60);
    await vi.waitFor(() =>
      expect(h.realtime.listeners.has(`job:${deliveredJobId}`)).toBe(true),
    );
    expect(h.request.mock.calls[0]?.slice(1, 4)).toEqual([
      "/media-imports/cache-deliveries",
      "POST",
      {
        url,
        request_id: expect.stringMatching(
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
        ),
        trim_enabled: false,
      },
    ]);
    h.realtime.emit("job", deliveredJobId, job({ id: deliveredJobId }));
    expect((await result)?.id).toBe(deliveredJobId);
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.resolveDownload).not.toHaveBeenCalled();
    expect(h.realtime.listeners.size).toBe(0);
  });
  it("returns a shared cache miss once without a normal import, download or job subscription", async () => {
    const h = harness();
    h.realtime.read.mockResolvedValue({ items: [], next_cursor: null });
    expect(await h.provider.findReusableYouTube("bZxrIoCPsOc", 60)).toBeNull();
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.request.mock.calls[0]?.[1]).toBe(
      "/media-imports/cache-deliveries",
    );
    expect(h.resolveDownload).not.toHaveBeenCalled();
    expect(h.realtime.listeners.size).toBe(0);
  });
  it("recovers a queued shared delivery through owner snapshots without polling or replaying its command", async () => {
    const h = harness(async () => imported());
    h.realtime.read.mockResolvedValue({ items: [], next_cursor: null });
    const result = h.provider.findReusableYouTube("bZxrIoCPsOc", 60);
    await vi.waitFor(() =>
      expect(h.realtime.listeners.has(`import:${importId}`)).toBe(true),
    );
    h.realtime.emit("import", importId, imported("submitted", jobId));
    await vi.waitFor(() =>
      expect(h.realtime.listeners.has(`job:${jobId}`)).toBe(true),
    );
    h.realtime.emit("job", jobId, job());
    expect((await result)?.id).toBe(jobId);
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.realtime.read).toHaveBeenCalledOnce();
    expect(h.resolveDownload).not.toHaveBeenCalled();
    expect(h.realtime.listeners.size).toBe(0);
  });
  it.each([false, true])(
    "returns sanitized shared delivery failure without retries (snapshot recovery: %s)",
    async (recovering) => {
      const failure = {
        ...imported("failed"),
        error: {
          code: "IMPORT_SOURCE_UNAVAILABLE",
          message: "private error text",
        },
      };
      const h = harness(async () => (recovering ? imported() : failure));
      h.realtime.read.mockResolvedValue({ items: [], next_cursor: null });
      const result = h.provider.findReusableYouTube("bZxrIoCPsOc", 60);
      const rejection = expect(result).rejects.toMatchObject({
        code: "IMPORT_SOURCE_UNAVAILABLE",
        message: "IMPORT_SOURCE_UNAVAILABLE",
      });
      if (recovering) {
        await vi.waitFor(() =>
          expect(h.realtime.listeners.has(`import:${importId}`)).toBe(true),
        );
        h.realtime.emit("import", importId, failure);
      }
      await rejection;
      expect(h.request).toHaveBeenCalledOnce();
      expect(h.resolveDownload).not.toHaveBeenCalled();
      expect(h.realtime.listeners.size).toBe(0);
    },
  );
  it.each([
    new DesktopApiError("AUTH_REQUIRED", 401),
    new DesktopApiError("PROCESSING_NOT_ALLOWED", 403),
    new DesktopApiError("RETAINED_STORAGE_LIMIT_REACHED", 429),
    new DesktopApiError("NOT_FOUND", 404),
    new DesktopApiError("IMPORT_CACHE_MISS", 503),
  ])(
    "preserves genuine shared-cache errors %s without starting work",
    async (error) => {
      const h = harness(async () => {
        throw error;
      });
      h.realtime.read.mockResolvedValue({ items: [], next_cursor: null });
      await expect(
        h.provider.findReusableYouTube("bZxrIoCPsOc", 60),
      ).rejects.toBe(error);
      expect(h.request).toHaveBeenCalledOnce();
      expect(h.resolveDownload).not.toHaveBeenCalled();
      expect(h.realtime.listeners.size).toBe(0);
    },
  );
  it.each([
    [{ recipe_digest: "0".repeat(64) }, "TIMELINE_INCOMPATIBLE"],
    [{ trim_enabled: true }, "TIMELINE_INCOMPATIBLE"],
    [{ input: { ...input, duration_seconds: 59 } }, "SOURCE_IDENTITY_MISMATCH"],
    [
      { input: { ...input, duration_seconds: 901 } },
      "SOURCE_IDENTITY_MISMATCH",
    ],
    [
      { source_url: "https://www.youtube.com/watch?v=abcdefghijk" },
      "SOURCE_IDENTITY_MISMATCH",
    ],
  ])(
    "validates shared delivery metadata %j before returning a result",
    async (overrides, code) => {
      const h = harness(async () => imported("submitted", jobId));
      h.realtime.read.mockResolvedValue({ items: [], next_cursor: null });
      const result = h.provider.findReusableYouTube("bZxrIoCPsOc", 60);
      const rejection = expect(result).rejects.toMatchObject({ code });
      await vi.waitFor(() =>
        expect(h.realtime.listeners.has(`job:${jobId}`)).toBe(true),
      );
      h.realtime.emit("job", jobId, job(overrides));
      await rejection;
      expect(h.request).toHaveBeenCalledOnce();
      expect(h.resolveDownload).not.toHaveBeenCalled();
      expect(h.realtime.listeners.size).toBe(0);
    },
  );
  it.each([
    { ...imported(), status: "invalid" },
    imported("submitted"),
    { ...imported("submitted", jobId), import_id: "invalid" },
    { ...imported("submitted", jobId), error: { code: "IMPORT_FAILED" } },
  ])(
    "rejects invalid shared delivery receipts %j without subscribing or retrying",
    async (receipt) => {
      const h = harness(async () => receipt);
      h.realtime.read.mockResolvedValue({ items: [], next_cursor: null });
      await expect(
        h.provider.findReusableYouTube("bZxrIoCPsOc", 60),
      ).rejects.toMatchObject({ code: "CLOUD_REPLY_INVALID" });
      expect(h.request).toHaveBeenCalledOnce();
      expect(h.resolveDownload).not.toHaveBeenCalled();
      expect(h.realtime.listeners.size).toBe(0);
    },
  );
  it("fences an account change during shared delivery before subscribing to the job", async () => {
    const h = harness(async () => {
      h.changeOwner();
      return imported("submitted", jobId);
    });
    h.realtime.read.mockResolvedValue({ items: [], next_cursor: null });
    await expect(
      h.provider.findReusableYouTube("bZxrIoCPsOc", 60),
    ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.realtime.listeners.size).toBe(0);
  });
  it("fences a late shared job snapshot after an account change", async () => {
    const h = harness(async () => imported("submitted", jobId));
    h.realtime.read.mockResolvedValue({ items: [], next_cursor: null });
    const result = h.provider.findReusableYouTube("bZxrIoCPsOc", 60);
    const rejection = expect(result).rejects.toMatchObject({
      code: "ACCOUNT_CHANGED",
    });
    await vi.waitFor(() =>
      expect(h.realtime.listeners.has(`job:${jobId}`)).toBe(true),
    );
    h.changeOwner();
    h.realtime.emit("job", jobId, job());
    await rejection;
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.resolveDownload).not.toHaveBeenCalled();
    expect(h.realtime.listeners.size).toBe(0);
  });
  it("uses measured full-timeline YouTube duration during ready-account lookup", async () => {
    const h = harness();
    h.realtime.read.mockResolvedValue({
      items: [job({ input: { ...input, duration_seconds: 59 } }), job()],
      next_cursor: null,
    });
    expect(
      (await h.provider.findReusableYouTube("bZxrIoCPsOc", 60))?.input
        .duration_seconds,
    ).toBe(60);
    expect(h.request).not.toHaveBeenCalled();
  });
  it("preserves canonical legacy YouTube reuse when source kind is absent", async () => {
    const h = harness();
    h.realtime.read
      .mockResolvedValueOnce({
        items: [job({ source_kind: null })],
        next_cursor: null,
      })
      .mockResolvedValueOnce(job({ source_kind: null }));
    expect((await h.provider.findReusableYouTube("bZxrIoCPsOc", 60))?.id).toBe(
      jobId,
    );
    await h.provider.downloadJob(jobId, {
      video_id: "bZxrIoCPsOc",
      duration_seconds: 60,
    });
    expect(h.request).toHaveBeenCalledOnce();
  });
  it.each([
    { source_url: "https://www.youtube.com/watch?v=abcdefghijk" },
    { input: { ...input, duration_seconds: 59 } },
    { input: { ...input, duration_seconds: 901 } },
    { trim_enabled: true },
    { recipe_digest: "0".repeat(64) },
  ])(
    "revalidates changed YouTube source metadata before a grant %j",
    async (overrides) => {
      const h = harness();
      h.realtime.read.mockResolvedValue(job(overrides));
      await expect(
        h.provider.downloadJob(jobId, {
          video_id: "bZxrIoCPsOc",
          duration_seconds: 60,
        }),
      ).rejects.toMatchObject({ code: "SOURCE_IDENTITY_MISMATCH" });
      expect(h.request).not.toHaveBeenCalled();
      expect(h.resolveDownload).not.toHaveBeenCalled();
    },
  );
  it("checks a known committed file job before bounded owner pages without creating work", async () => {
    const h = harness();
    h.realtime.read.mockResolvedValue(
      job({ source_kind: "file", source_url: null }),
    );
    const found = await h.provider.findReusableFile(input, jobId);
    expect(found?.id).toBe(jobId);
    expect(h.realtime.read).toHaveBeenCalledOnce();
    expect(h.realtime.read.mock.calls[0]?.slice(0, 2)).toEqual([
      "job",
      { id: jobId },
    ]);
    expect(h.request).not.toHaveBeenCalled();
    await h.provider.downloadJob(jobId, input);
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.request.mock.calls[0]?.[1]).toBe(`/jobs/${jobId}/download-grants`);
  });
  it.each([
    { input: { ...input, sha256: Buffer.alloc(32, 2).toString("base64") } },
    { input: { ...input, bytes: input.bytes + 1 } },
    { input: { ...input, extension: "wav", content_type: "audio/wav" } },
    { input: { ...input, duration_seconds: 59 } },
    { trim_enabled: true },
    { recipe_digest: "0".repeat(64) },
    { processing_origin: "local_device", local_profile_id: null },
    { output: null },
    { source_kind: "url", source_url: url },
    { status: "processing", can_download_output: false },
  ])("skips incompatible owned file results %j", async (overrides) => {
    const h = harness();
    const incompatible = job({
      source_kind: "file",
      source_url: null,
      ...overrides,
    });
    h.realtime.read
      .mockResolvedValueOnce(incompatible)
      .mockResolvedValueOnce({ items: [incompatible], next_cursor: null });
    expect(await h.provider.findReusableFile(input, jobId)).toBeNull();
    expect(h.realtime.read).toHaveBeenCalledTimes(2);
    expect(h.request).not.toHaveBeenCalled();
  });
  it("falls back from a deleted committed job to bounded ready file snapshots", async () => {
    const h = harness();
    h.realtime.read
      .mockRejectedValueOnce(new DesktopApiError("JOB_NOT_FOUND", 404))
      .mockResolvedValueOnce({
        items: [job({ source_kind: "file", source_url: null })],
        next_cursor: null,
      });
    expect((await h.provider.findReusableFile(input, jobId))?.id).toBe(jobId);
    expect(h.realtime.read.mock.calls[1]?.slice(0, 2)).toEqual([
      "jobs",
      { limit: "50", status: "ready" },
    ]);
    expect(h.request).not.toHaveBeenCalled();
  });
  it("bounds file pages and rejects a changed source before obtaining a download grant", async () => {
    const h = harness();
    let page = 0;
    h.realtime.read.mockImplementation(async () => ({
      items: [],
      next_cursor: `page${++page}`,
    }));
    expect(await h.provider.findReusableFile(input)).toBeNull();
    expect(h.realtime.read).toHaveBeenCalledTimes(10);
    h.realtime.read.mockResolvedValue(
      job({ source_kind: "file", source_url: null, trim_enabled: true }),
    );
    await expect(h.provider.downloadJob(jobId, input)).rejects.toMatchObject({
      code: "SOURCE_IDENTITY_MISMATCH",
    });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.resolveDownload).not.toHaveBeenCalled();
  });
  it("fences file lookup and grant acquisition after an account generation changes", async () => {
    const h = harness();
    h.realtime.read.mockImplementation(async () => {
      h.changeOwner();
      return job({ source_kind: "file", source_url: null });
    });
    await expect(
      h.provider.findReusableFile(input, jobId),
    ).rejects.toMatchObject({
      code: "ACCOUNT_CHANGED",
    });
    expect(h.request).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "uses the prepared cloud file contract and confirms an exact upload (ambiguous receipt: %s)",
    async (ambiguous) => {
      const uploadGrant = {
        method: "PUT",
        ...grant(),
        headers: {
          "Content-Type": input.content_type,
          "If-None-Match": "*",
          "x-amz-checksum-sha256": hash,
          "x-amz-meta-sha256": hash,
        },
      };
      const h = harness(async (path) =>
        path === "/jobs"
          ? {
              id: jobId,
              request_id: requestId,
              status: "awaiting_upload",
              upload: uploadGrant,
            }
          : path.endsWith("/upload-completions")
            ? { id: jobId, status: "queued" }
            : grant(),
      );
      const upload = ambiguous
        ? vi.fn().mockRejectedValue(new DesktopApiError("UPLOAD_AMBIGUOUS"))
        : vi.fn().mockResolvedValue(undefined);
      const result = h.provider.startFile(
        { request_id: requestId, input, source: "audio_file" },
        upload,
      );
      await vi.waitFor(() =>
        expect(h.realtime.listeners.has(`job:${jobId}`)).toBe(true),
      );
      expect(upload).toHaveBeenCalledOnce();
      expect(h.request.mock.calls[0]?.[3]).toMatchObject({
        policy_version: 2,
        preparation_profile_id: "audio-cap-aac-lc-160-v1",
        trim_enabled: false,
        source_kind: "file",
        input,
      });
      h.realtime.emit(
        "job",
        jobId,
        job({ source_kind: "file", source_url: null }),
      );
      await result;
      expect(
        h.request.mock.calls.filter((call) =>
          call[1].endsWith("/upload-completions"),
        ),
      ).toHaveLength(1);
    },
  );
  it("permits a trimmed Library result for standalone native playback", async () => {
    const h = harness();
    h.realtime.read.mockResolvedValue(job({ trim_enabled: true }));
    expect((await h.provider.downloadJob(jobId)).job.trim_enabled).toBe(true);
    expect(h.request).toHaveBeenCalledOnce();
  });
  it("rejects a valid but unrelated import snapshot", async () => {
    const h = harness();
    const result = h.provider.startYouTube({ url, request_id: requestId });
    const rejection = expect(result).rejects.toMatchObject({
      code: "CLOUD_REPLY_INVALID",
    });
    await flush();
    h.realtime.emit("import", importId, {
      ...imported("submitted", jobId),
      import_id: jobId,
    });
    await rejection;
    expect(h.request).toHaveBeenCalledOnce();
  });
  it("rechecks scope after a download callback before returning account data", async () => {
    const h = harness();
    h.realtime.read.mockResolvedValue(job());
    h.resolveDownload.mockImplementation(async () => h.changeOwner());
    await expect(h.provider.downloadJob(jobId)).rejects.toMatchObject({
      code: "ACCOUNT_CHANGED",
    });
  });
  it("rejects malformed hashes/private metadata and preserves unknown cloud output duration", () => {
    const parsed = parseJobMetadata(
      job({
        private_key: "users/private",
        private_url: "https://private?secret",
        error: { code: "OUTPUT_INVALID", message: "private exception" },
      }),
    );
    expect(parsed.output?.duration_seconds).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain("private");
    expect(() =>
      parseJobMetadata(job({ input: { ...input, sha256: "not-a-hash" } })),
    ).toThrow("CLOUD_REPLY_INVALID");
    expect(fullTimeline(parsed)).toBe(true);
    expect(
      fullTimeline(
        parseJobMetadata(job({ processing_origin: "local_device" })),
      ),
    ).toBe(false);
  });
  it("preserves the original public thumbnail and treats missing or unsafe values as null", () => {
    const thumbnail =
      "https://i.ytimg.com/vi/bZxrIoCPsOc/hqdefault.jpg?sqp=fixture_123&rs=signature-123";
    expect(
      parseJobMetadata(job({ thumbnail_url: thumbnail })).thumbnail_url,
    ).toBe(thumbnail);
    for (const value of [
      undefined,
      null,
      1,
      "https://private.invalid/video.jpg",
    ])
      expect(
        parseJobMetadata(job({ thumbnail_url: value })).thumbnail_url,
      ).toBeNull();
  });

  it("retains backend-valid format characters in optional display titles", () => {
    // Backend isAudioName permits Cf (for example Farsi joiners and emoji ZWJ),
    // while rejecting Cc. Display text is not an audio identity declaration.
    const title = "صدای موسیقی\u200c و خانواده 👨\u200d👩\u200d👧";
    expect(
      parseJobMetadata(job({ source_title: title, display_name: title })),
    ).toMatchObject({ source_title: title, display_name: title });
    expect(() =>
      parseJobMetadata(job({ source_title: "invalid\ncontrol" })),
    ).toThrow("CLOUD_REPLY_INVALID");
  });

  it("represents optional legacy input metadata without inventing a hash or content type", () => {
    // JobView requires extension/bytes/duration_seconds; presenter legacy
    // fixtures omit content_type/sha256 rather than inventing source identity.
    const declared = { extension: "mp3", bytes: 100, duration_seconds: 10 };
    const parsed = parseJobMetadata(
      job({ input: declared, output: null, can_download_output: false }),
    );
    expect(parsed.input).toEqual(declared);
    expect(parsed.input).not.toHaveProperty("sha256");
    expect(parsed.input).not.toHaveProperty("content_type");
  });

  it("reads a documented legacy history row before an eligible account result", async () => {
    const h = harness();
    h.realtime.read.mockResolvedValue({
      items: [
        job({
          id: "0123456789abcdef01234569",
          source_kind: "file",
          source_url: null,
          input: { extension: "mp3", bytes: 100, duration_seconds: 10 },
          output: null,
          can_download_output: false,
        }),
        job(),
      ],
      next_cursor: null,
    });
    expect((await h.provider.findReusableYouTube("bZxrIoCPsOc"))?.id).toBe(
      jobId,
    );
    expect(h.realtime.read).toHaveBeenCalledOnce();
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each([
    { content_type: null },
    { content_type: "audio/wav" },
    { content_type: 1 },
    { sha256: null },
    { sha256: "invalid" },
    { sha256: 1 },
  ])("still rejects malformed present original metadata %j", (invalid) => {
    expect(() =>
      parseJobMetadata(job({ input: { ...input, ...invalid } })),
    ).toThrow("CLOUD_REPLY_INVALID");
  });

  it.each(["unknown", "constructor", "__proto__"])(
    "requires an allowlisted extension even without optional original metadata: %s",
    (extension) => {
      expect(() =>
        parseJobMetadata(
          job({ input: { extension, bytes: 100, duration_seconds: 10 } }),
        ),
      ).toThrow("CLOUD_REPLY_INVALID");
    },
  );

  it.each([["sha256"], ["content_type"], ["sha256", "content_type"]])(
    "does not infer original identity or create grants/work from missing metadata %j",
    async (...missing) => {
      const h = harness();
      const incomplete: Record<string, unknown> = { ...input };
      for (const field of missing) delete incomplete[field];
      const legacy = job({
        source_kind: "file",
        source_url: null,
        input: incomplete,
      });
      h.realtime.read.mockResolvedValue({ items: [legacy], next_cursor: null });
      expect(await h.provider.findReusableFile(input)).toBeNull();
      h.realtime.read.mockResolvedValue(legacy);
      await expect(h.provider.downloadJob(jobId, input)).rejects.toMatchObject({
        code: "SOURCE_IDENTITY_MISMATCH",
      });
      const upload = vi.fn();
      await expect(
        h.provider.startFile(
          {
            request_id: requestId,
            input: incomplete as unknown as typeof input,
            source: "audio_file",
          },
          upload,
        ),
      ).rejects.toMatchObject({ code: "CLOUD_REPLY_INVALID" });
      expect(h.request).not.toHaveBeenCalled();
      expect(h.resolveDownload).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
    },
  );

  it.each([
    [null, "job_record"],
    [job({ id: "invalid" }), "job_id"],
    [job({ request_id: "invalid" }), "job_request_id"],
    [job({ status: "invalid" }), "job_status"],
    [job({ trim_enabled: null }), "job_trim"],
    [job({ can_download_output: null }), "job_capabilities"],
    [job({ input: null }), "input_record"],
    [job({ input: { ...input, extension: "__proto__" } }), "input_extension"],
    [job({ input: { ...input, content_type: null } }), "input_content_type"],
    [job({ input: { ...input, bytes: 0 } }), "input_bytes"],
    [job({ input: { ...input, duration_seconds: 0 } }), "input_duration"],
    [job({ input: { ...input, sha256: "private-invalid" } }), "input_hash"],
    [job({ output: [] }), "output_record"],
    [
      job({ output: { ...job().output, content_type: "invalid" } }),
      "output_format",
    ],
    [job({ output: { ...job().output, bytes: 0 } }), "output_bytes"],
    [
      job({ output: { ...job().output, sha256: "private-invalid" } }),
      "output_hash",
    ],
    [
      job({ output: { ...job().output, duration_seconds: 0 } }),
      "output_duration",
    ],
    [job({ source_url: "https://youtu.be/bZxrIoCPsOc" }), "source_reference"],
    [job({ recipe_digest: "private-invalid" }), "recipe_digest"],
    [job({ processing_origin: "private-invalid" }), "processing_origin"],
    [job({ local_profile_id: "private-invalid" }), "local_profile"],
    [job({ source_kind: "private-invalid" }), "source_kind"],
    [job({ source_title: "private\ninvalid" }), "source_title"],
    [job({ display_name: "private\ninvalid" }), "display_name"],
    [job({ error: { code: "private invalid" } }), "error_metadata"],
  ])(
    "identifies a closed validation location without changing the error code %#",
    (value, reason) => {
      let failure: unknown;
      try {
        parseJobMetadata(value);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CloudReplyValidationError);
      expect(failure).toMatchObject({
        code: "CLOUD_REPLY_INVALID",
        validationReason: reason,
        message: "CLOUD_REPLY_INVALID",
      });
      expect(JSON.stringify(failure)).not.toContain("private-invalid");
    },
  );

  it.each([
    [{ items: null, next_cursor: null }, "history_page"],
    [{ items: [], next_cursor: "private invalid" }, "history_cursor"],
  ])(
    "keeps history validation failures precise and read-only %#",
    async (page, reason) => {
      const h = harness();
      h.realtime.read.mockResolvedValue(page);
      await expect(
        h.provider.findReusableYouTube("bZxrIoCPsOc"),
      ).rejects.toMatchObject({
        code: "CLOUD_REPLY_INVALID",
        validationReason: reason,
      });
      expect(h.request).not.toHaveBeenCalled();
    },
  );
});
