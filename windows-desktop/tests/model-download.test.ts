import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  downloadPinnedModel,
  type ModelPin,
} from "../src/main/prepare/model-download.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { nodePrivateFileFixture } from "./private-file-port-fixture.js";
import type { PrivateWritable } from "../../worker/src/platform/windows/consumer-private-file.js";
const bytes = Buffer.from("synthetic-pinned-model");
const pin: ModelPin = {
  url: MODEL.url,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
async function withOutput(
  run: (file: PrivateWritable, path: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "musicmute-model-")),
    path = join(root, "staging");
  const file = await open(path, "wx+");
  try {
    await run(nodePrivateFileFixture(file), path);
  } finally {
    await file.close();
    await rm(root, { recursive: true, force: true });
  }
}
it("verifies an upstream-pinned streamed model and reports measured bytes", async () => {
  await withOutput(async (file, path) => {
    const progress = vi.fn();
    const fetcher = vi.fn(
      async () =>
        new Response(bytes, {
          headers: { "Content-Length": String(bytes.length) },
        }),
    );
    await downloadPinnedModel(file, pin, {
      signal: new AbortController().signal,
      fetch: fetcher as typeof fetch,
      onProgress: progress,
    });
    expect(await readFile(path)).toEqual(bytes);
    expect(progress).toHaveBeenCalledWith(bytes.length, bytes.length);
    expect(fetcher.mock.calls).toHaveLength(1);
  });
});
it("follows only reviewed HTTPS GitHub asset redirects and excludes inherited credentials", async () => {
  await withOutput(async (file) => {
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      expect(init.redirect).toBe("manual");
      expect(init.headers).toEqual({ Accept: "application/octet-stream" });
      return url.hostname === "github.com"
        ? new Response(null, {
            status: 302,
            headers: {
              Location:
                "https://release-assets.githubusercontent.com/synthetic",
            },
          })
        : new Response(bytes);
    });
    await downloadPinnedModel(file, pin, {
      signal: new AbortController().signal,
      fetch: fetcher as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
it.each([
  "http://release-assets.githubusercontent.com/model",
  "https://evil.example/model",
  "https://user:secret@objects.githubusercontent.com/model",
])("rejects redirected model %s", async (location) => {
  await withOutput(async (file) => {
    await expect(
      downloadPinnedModel(file, pin, {
        signal: new AbortController().signal,
        fetch: (async () =>
          new Response(null, {
            status: 302,
            headers: { Location: location },
          })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "INTEGRITY_INVALID" });
    expect((await file.info()).bytes).toBe(0);
  });
});
it.each([
  new Response("wrong", { headers: { "Content-Length": "5" } }),
  new Response(Buffer.concat([bytes, Buffer.from("extra")])),
  new Response(Buffer.alloc(bytes.length, 0)),
  new Response(bytes, { status: 206 }),
])(
  "rejects wrong lengths, digest and partial HTTP responses",
  async (response) => {
    await withOutput(async (file) => {
      await expect(
        downloadPinnedModel(file, pin, {
          signal: new AbortController().signal,
          fetch: (async () => response) as typeof fetch,
        }),
      ).rejects.toThrow();
    });
  },
);
it("honors cancellation and refuses to overwrite a populated staging file", async () => {
  await withOutput(async (file) => {
    const abort = new AbortController();
    abort.abort();
    const fetcher = vi.fn();
    await expect(
      downloadPinnedModel(file, pin, { signal: abort.signal, fetch: fetcher }),
    ).rejects.toMatchObject({ code: "PREPARE_INTERRUPTED" });
    expect(fetcher).not.toHaveBeenCalled();
    await file.writeFile("preserve");
    await expect(
      downloadPinnedModel(file, pin, {
        signal: new AbortController().signal,
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({ code: "INTEGRITY_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
