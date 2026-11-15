import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadCloudOutput,
  uploadCloudAudio,
} from "../src/main/cloud/transfers.js";
import type { JobMetadata } from "../../chrome-extension/src/companion/cloud-provider.js";
import { nodePrivateFileFixture } from "./private-file-port-fixture.js";
import { PRIVATE_FILE_CHUNK_BYTES } from "../../worker/src/platform/windows/consumer-private-file.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(media: Buffer = Buffer.from("synthetic-mp3-media")) {
  const root = await mkdtemp(join(tmpdir(), "musicmute-cloud-code-"));
  roots.push(root);
  const bytes = Buffer.from(media),
    sha = createHash("sha256").update(bytes).digest("base64"),
    file = await open(join(root, "output.part"), "wx", 0o600),
    input = {
      extension: "m4a",
      content_type: "audio/mp4",
      bytes: bytes.length,
      duration_seconds: 60,
      sha256: sha,
    },
    job = {
      id: "0123456789abcdef01234567",
      status: "ready",
      can_download_output: true,
      output: {
        extension: "mp3",
        content_type: "audio/mpeg",
        bytes: bytes.length,
        duration_seconds: 60,
        sha256: sha,
      },
    } as JobMetadata,
    grant = {
      url: "https://fixture.r2.cloudflarestorage.com/output?signature=fixture",
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };
  return {
    root,
    bytes,
    sha,
    file,
    destination: nodePrivateFileFixture(file),
    input,
    job,
    grant,
  };
}
async function uploadFixture(media?: Buffer) {
  const f = await fixture(media),
    path = join(f.root, "input.m4a");
  await writeFile(path, f.bytes, { mode: 0o600 });
  const file = nodePrivateFileFixture(
      await open(path, "r"),
      f.bytes.length,
      "read",
    ),
    release = file.close.bind(file),
    close = vi.spyOn(file, "close"),
    grant = {
      method: "PUT" as const,
      ...f.grant,
      headers: {
        "Content-Type": "audio/mp4",
        "If-None-Match": "*",
        "x-amz-checksum-sha256": f.sha,
        "x-amz-meta-sha256": f.sha,
      },
    };
  return { ...f, source: { path, file }, close, release, uploadGrant: grant };
}
function deferred() {
  let ready = false;
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: () => {
      ready = true;
      resolve();
    },
    get ready() {
      return ready;
    },
  };
}
describe("bounded owner-fenced R2 transfers", () => {
  it("real Node fetch early201 headers cannot finish a gated native-reader upload", async () => {
    const f = await uploadFixture(
        Buffer.alloc(PRIVATE_FILE_CHUNK_BYTES * 3 + 79, 67),
      ),
      remainder = deferred(),
      headersReceived = deferred(),
      chunks = f.source.file.chunks.bind(f.source.file),
      received: Buffer[] = [];
    vi.spyOn(f.source.file, "chunks").mockImplementation(
      async function* (options) {
        let first = true;
        for await (const bytes of chunks(options)) {
          yield bytes;
          if (first) {
            first = false;
            await remainder.promise;
          }
        }
      },
    );
    const server = createServer((request, response) => {
      request.on("data", (bytes: Buffer) => received.push(Buffer.from(bytes)));
      request.once("data", () => {
        response.writeHead(201);
        response.flushHeaders();
      });
      request.once("end", () => response.end());
      request.on("error", () => {});
    });
    const abort = new AbortController();
    let settled = false;
    let uploading: Promise<void> | undefined;
    try {
      const listening = once(server, "listening", {
        signal: AbortSignal.timeout(2000),
      });
      void listening.catch(() => {});
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("HTTP_FIXTURE_BIND");
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/fixture`,
          init,
        );
        headersReceived.resolve();
        return response;
      });
      uploading = uploadCloudAudio(f.source, f.input, f.uploadGrant, {
        signal: abort.signal,
        assertCurrent: () => {},
        fetch: fetcher,
      }).finally(() => {
        settled = true;
      });
      void uploading.catch(() => {});
      await vi.waitFor(() => expect(headersReceived.ready).toBe(true), {
        timeout: 2000,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(f.close).not.toHaveBeenCalled();
      remainder.resolve();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2000 });
      await uploading;
      await vi.waitFor(() => expect(Buffer.concat(received)).toEqual(f.bytes));
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith(
        f.uploadGrant.url,
        expect.objectContaining({ redirect: "error" }),
      );
    } finally {
      remainder.resolve();
      abort.abort();
      await uploading?.catch(() => {});
      if (server.listening) {
        const closing = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeAllConnections();
        await closing;
      } else server.closeAllConnections();
      await f.source.file.close();
      await f.file.close();
    }
  }, 10000);
  it("early2xx waits for natural source EOF even after every declared byte was yielded", async () => {
    const f = await uploadFixture(
        Buffer.alloc(PRIVATE_FILE_CHUNK_BYTES * 3 + 11, 69),
      ),
      reachedEnd = deferred(),
      finish = deferred();
    vi.spyOn(f.source.file, "chunks").mockImplementation(async function* () {
      for (
        let offset = 0;
        offset < f.bytes.length;
        offset += PRIVATE_FILE_CHUNK_BYTES
      )
        yield f.bytes.subarray(offset, offset + PRIVATE_FILE_CHUNK_BYTES);
      reachedEnd.resolve();
      await finish.promise;
    });
    let body: Promise<ArrayBuffer> | undefined,
      settled = false;
    const uploading = uploadCloudAudio(f.source, f.input, f.uploadGrant, {
      signal: new AbortController().signal,
      assertCurrent: () => {},
      fetch: async (_url, init) => {
        body = new Response(init!.body).arrayBuffer();
        void body.catch(() => {});
        return new Response(null, { status: 201 });
      },
    }).finally(() => {
      settled = true;
    });
    void uploading.catch(() => {});
    try {
      await vi.waitFor(() => expect(reachedEnd.ready).toBe(true), {
        timeout: 2000,
      });
      expect(settled).toBe(false);
      expect(f.close).not.toHaveBeenCalled();
      finish.resolve();
      await uploading;
      expect(Buffer.from(await body!)).toEqual(f.bytes);
      expect(f.close).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve();
      await uploading.catch(() => {});
      await body?.catch(() => {});
      await f.source.file.close();
      await f.file.close();
    }
  });
  it.each([
    ["body", "ACCOUNT_CHANGED"],
    ["body", "SESSION_CHANGED"],
    ["info", "ACCOUNT_CHANGED"],
    ["info", "SESSION_CHANGED"],
  ] as const)(
    "%s completion rechecks %s without relying on an abort",
    async (stage, code) => {
      const f = await uploadFixture(
          Buffer.alloc(PRIVATE_FILE_CHUNK_BYTES * 2 + 11, 71),
        ),
        reached = deferred(),
        finish = deferred(),
        abort = new AbortController(),
        identity = await f.source.file.info();
      let current = true,
        infos = 0,
        body: Promise<ArrayBuffer> | undefined;
      vi.spyOn(f.source.file, "info").mockImplementation(async () => {
        if (stage === "info" && ++infos === 2) {
          reached.resolve();
          await finish.promise;
        }
        return identity;
      });
      if (stage === "body")
        vi.spyOn(f.source.file, "chunks").mockImplementation(
          async function* () {
            for (
              let offset = 0;
              offset < f.bytes.length;
              offset += PRIVATE_FILE_CHUNK_BYTES
            )
              yield f.bytes.subarray(offset, offset + PRIVATE_FILE_CHUNK_BYTES);
            reached.resolve();
            await finish.promise;
          },
        );
      const uploading = uploadCloudAudio(f.source, f.input, f.uploadGrant, {
        signal: abort.signal,
        assertCurrent: () => {
          if (!current) throw new Error(code);
        },
        fetch: async (_url, init) => {
          body = new Response(init!.body).arrayBuffer();
          void body.catch(() => {});
          return new Response(null, { status: 201 });
        },
      });
      void uploading.catch(() => {});
      try {
        await vi.waitFor(() => expect(reached.ready).toBe(true), {
          timeout: 2000,
        });
        expect(f.close).not.toHaveBeenCalled();
        current = false;
        finish.resolve();
        await expect(uploading).rejects.toMatchObject({
          code: "ACCOUNT_CHANGED",
        });
        expect(abort.signal.aborted).toBe(false);
        expect(f.close).toHaveBeenCalledTimes(1);
      } finally {
        finish.resolve();
        abort.abort();
        await uploading.catch(() => {});
        await body?.catch(() => {});
        await f.source.file.close();
        await f.file.close();
      }
    },
  );
  it.each(["short", "late-error", "overshoot"] as const)(
    "rejects early2xx with %s source completion and closes the reader",
    async (failure) => {
      const f = await uploadFixture(
        Buffer.alloc(PRIVATE_FILE_CHUNK_BYTES * 3 + 11, 71),
      );
      vi.spyOn(f.source.file, "chunks").mockImplementation(async function* () {
        yield f.bytes.subarray(0, PRIVATE_FILE_CHUNK_BYTES);
        if (failure === "short") return;
        if (failure === "late-error")
          throw new Error("NATIVE_LATE_READ_FAILED");
        for (
          let offset = PRIVATE_FILE_CHUNK_BYTES;
          offset < f.bytes.length;
          offset += PRIVATE_FILE_CHUNK_BYTES
        )
          yield f.bytes.subarray(offset, offset + PRIVATE_FILE_CHUNK_BYTES);
        yield Buffer.from("extra");
      });
      let body: Promise<ArrayBuffer> | undefined;
      try {
        await expect(
          uploadCloudAudio(f.source, f.input, f.uploadGrant, {
            signal: new AbortController().signal,
            assertCurrent: () => {},
            fetch: async (_url, init) => {
              body = new Response(init!.body).arrayBuffer();
              void body.catch(() => {});
              return new Response(null, { status: 201 });
            },
          }),
        ).rejects.toThrow(
          failure === "late-error"
            ? "UPLOAD_UNAVAILABLE"
            : "CLOUD_INPUT_INVALID",
        );
        expect(f.close).toHaveBeenCalledTimes(1);
        expect(await readFile(f.source.path)).toEqual(f.bytes);
      } finally {
        await body?.catch(() => {});
        await f.source.file.close();
        await f.file.close();
      }
    },
  );
  it("abort while awaiting body completion rejects and closes without waiting for an ignored source gate", async () => {
    const f = await uploadFixture(
        Buffer.alloc(PRIVATE_FILE_CHUNK_BYTES * 3, 73),
      ),
      waiting = deferred(),
      finish = deferred(),
      abort = new AbortController();
    vi.spyOn(f.source.file, "chunks").mockImplementation(async function* () {
      yield f.bytes.subarray(0, PRIVATE_FILE_CHUNK_BYTES);
      waiting.resolve();
      await finish.promise;
      yield f.bytes.subarray(
        PRIVATE_FILE_CHUNK_BYTES,
        PRIVATE_FILE_CHUNK_BYTES * 2,
      );
    });
    let body: Promise<ArrayBuffer> | undefined;
    const uploading = uploadCloudAudio(f.source, f.input, f.uploadGrant, {
      signal: abort.signal,
      assertCurrent: () => {},
      fetch: async (_url, init) => {
        body = new Response(init!.body).arrayBuffer();
        void body.catch(() => {});
        return new Response(null, { status: 201 });
      },
    });
    void uploading.catch(() => {});
    try {
      await vi.waitFor(() => expect(waiting.ready).toBe(true), {
        timeout: 2000,
      });
      abort.abort();
      await expect(uploading).rejects.toThrow("CANCELLED");
      expect(f.close).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve();
      await uploading.catch(() => {});
      await body?.catch(() => {});
      await f.source.file.close();
      await f.file.close();
    }
  });
  it("an early412 does not require the held source remainder or EOF", async () => {
    const f = await uploadFixture(
        Buffer.alloc(PRIVATE_FILE_CHUNK_BYTES * 3, 75),
      ),
      finish = deferred();
    vi.spyOn(f.source.file, "chunks").mockImplementation(async function* () {
      yield f.bytes.subarray(0, PRIVATE_FILE_CHUNK_BYTES);
      await finish.promise;
      yield f.bytes.subarray(
        PRIVATE_FILE_CHUNK_BYTES,
        PRIVATE_FILE_CHUNK_BYTES * 2,
      );
    });
    const uploading = uploadCloudAudio(f.source, f.input, f.uploadGrant, {
      signal: new AbortController().signal,
      assertCurrent: () => {},
      fetch: async () => new Response(null, { status: 412 }),
    });
    try {
      await uploading;
      expect(f.close).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve();
      await uploading.catch(() => {});
      await f.source.file.close();
      await f.file.close();
    }
  });
  it("downloads and verifies exact bytes/hash without account bearer headers", async () => {
    const f = await fixture(),
      fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(f.bytes, {
            headers: {
              "content-type": "audio/mpeg",
              "content-length": String(f.bytes.length),
            },
          }),
      ),
      current = vi.fn();
    try {
      await downloadCloudOutput(f.destination, f.job, f.grant, {
        signal: new AbortController().signal,
        assertCurrent: current,
        fetch: fetcher,
      });
      expect(await readFile(join(f.root, "output.part"))).toEqual(f.bytes);
      expect(
        new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("authorization"),
      ).toBe(false);
      expect(fetcher.mock.calls[0]?.[0]).toBe(f.grant.url);
      expect(current.mock.calls.length).toBeGreaterThan(2);
    } finally {
      await f.file.close();
    }
  });
  it.each(["bytes", "hash", "type", "encoding"])(
    "refuses mismatched %s output",
    async (reason) => {
      const f = await fixture(),
        headers: Record<string, string> = { "content-type": "audio/mpeg" };
      if (reason === "type") headers["content-type"] = "text/html";
      if (reason === "encoding") headers["content-encoding"] = "gzip";
      const bytes =
        reason === "bytes"
          ? Buffer.concat([f.bytes, Buffer.from("extra")])
          : reason === "hash"
            ? Buffer.alloc(f.bytes.length, 1)
            : f.bytes;
      try {
        await expect(
          downloadCloudOutput(f.destination, f.job, f.grant, {
            signal: new AbortController().signal,
            assertCurrent: () => {},
            fetch: async () => new Response(bytes, { headers }),
          }),
        ).rejects.toThrow();
      } finally {
        await f.file.close();
      }
    },
  );
  it("expired or foreign grants never start a transfer", async () => {
    const f = await fixture(),
      fetcher = vi.fn<typeof fetch>();
    try {
      await expect(
        downloadCloudOutput(
          f.destination,
          f.job,
          { ...f.grant, expires_at: new Date(Date.now() - 1).toISOString() },
          {
            signal: new AbortController().signal,
            assertCurrent: () => {},
            fetch: fetcher,
          },
        ),
      ).rejects.toThrow("DOWNLOAD_GRANT_INVALID");
      await expect(
        downloadCloudOutput(
          f.destination,
          f.job,
          { ...f.grant, url: "https://attacker.invalid/file" },
          {
            signal: new AbortController().signal,
            assertCurrent: () => {},
            fetch: fetcher,
          },
        ),
      ).rejects.toThrow("DOWNLOAD_GRANT_INVALID");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await f.file.close();
    }
  });
  it("owner changes after response headers prevent writing the output", async () => {
    const f = await fixture();
    let valid = true;
    try {
      await expect(
        downloadCloudOutput(f.destination, f.job, f.grant, {
          signal: new AbortController().signal,
          assertCurrent: () => {
            if (!valid) throw new Error("ACCOUNT_CHANGED");
          },
          fetch: async () => {
            valid = false;
            return new Response(f.bytes);
          },
        }),
      ).rejects.toThrow("ACCOUNT_CHANGED");
      expect((await f.file.stat()).size).toBe(0);
    } finally {
      await f.file.close();
    }
  });
  it("abort rejects a response body that ignores the network signal", async () => {
    const f = await fixture(),
      abort = new AbortController();
    try {
      const downloading = downloadCloudOutput(f.destination, f.job, f.grant, {
        signal: abort.signal,
        assertCurrent: () => {},
        fetch: async () =>
          new Response(
            new ReadableStream({ pull: () => new Promise(() => {}) }),
          ),
      });
      await vi.waitFor(() => expect(f.file.fd).toBeGreaterThan(0));
      abort.abort();
      await expect(downloading).rejects.toThrow("CANCELLED");
    } finally {
      await f.file.close();
    }
  });
  it("uploads exact backend headers and bytes with no bearer credentials or URL rewrite", async () => {
    const f = await uploadFixture(),
      grant = f.uploadGrant,
      fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        expect(
          Buffer.from(await new Response(init!.body).arrayBuffer()),
        ).toEqual(f.bytes);
        return new Response(null, { status: 201 });
      });
    try {
      await uploadCloudAudio(f.source, f.input, grant, {
        signal: new AbortController().signal,
        assertCurrent: () => {},
        fetch: fetcher,
      });
      expect(fetcher.mock.calls[0]?.[0]).toBe(grant.url);
      const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.get("if-none-match")).toBe("*");
      expect(headers.get("x-amz-checksum-sha256")).toBe(f.sha);
      expect(f.close).toHaveBeenCalledTimes(1);
    } finally {
      await f.file.close();
    }
  });
  it("rejects an upload grant that adds credentials or changes the signed checksum", async () => {
    const f = await uploadFixture();
    const fetcher = vi.fn<typeof fetch>(),
      grant = {
        method: "PUT" as const,
        ...f.grant,
        headers: {
          "Content-Type": "audio/mp4",
          "If-None-Match": "*",
          "x-amz-checksum-sha256": f.sha,
          "x-amz-meta-sha256": f.sha,
          Authorization: "Bearer forbidden",
        },
      };
    try {
      await expect(
        uploadCloudAudio(f.source, f.input, grant, {
          signal: new AbortController().signal,
          assertCurrent: () => {},
          fetch: fetcher,
        }),
      ).rejects.toThrow("UPLOAD_GRANT_INVALID");
      expect(fetcher).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalledTimes(1);
    } finally {
      await f.file.close();
    }
  });
  it("streams several native chunks from the retained reader despite a replaced pathname", async () => {
    const f = await uploadFixture(
      Buffer.alloc(PRIVATE_FILE_CHUNK_BYTES * 4 + 79, 71),
    );
    const retainedPath = `${f.source.path}.retained`;
    // Portable held-reader proof only; Windows native share/identity fences are separate.
    await rename(f.source.path, retainedPath);
    await writeFile(f.source.path, Buffer.alloc(f.bytes.length, 0));
    const chunks: Uint8Array[] = [],
      fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(next.value);
        }
        return new Response(null, { status: 201 });
      });
    try {
      await uploadCloudAudio(f.source, f.input, f.uploadGrant, {
        signal: new AbortController().signal,
        assertCurrent: () => {},
        fetch: fetcher,
      });
      expect(chunks.length).toBeGreaterThan(4);
      expect(
        chunks.every((chunk) => chunk.length <= PRIVATE_FILE_CHUNK_BYTES),
      ).toBe(true);
      expect(Buffer.concat(chunks)).toEqual(f.bytes);
      expect(await readFile(retainedPath)).toEqual(f.bytes);
      expect(await readFile(f.source.path)).toEqual(
        Buffer.alloc(f.bytes.length),
      );
      expect(f.close).toHaveBeenCalledTimes(1);
    } finally {
      await f.source.file.close();
      await f.file.close();
    }
  });
  it.each([
    "device",
    "fileId",
    "bornAt",
    "bytes",
    "writtenAt",
    "changedAt",
  ] as const)(
    "rejects changed retained %s after streaming and closes the reader",
    async (field) => {
      const f = await uploadFixture(),
        before = await f.source.file.info(),
        after = {
          ...before,
          [field]:
            field === "bytes"
              ? before.bytes + 1
              : String(BigInt(before[field]) + 1n),
        };
      vi.spyOn(f.source.file, "info")
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after);
      try {
        await expect(
          uploadCloudAudio(f.source, f.input, f.uploadGrant, {
            signal: new AbortController().signal,
            assertCurrent: () => {},
            fetch: async (_url, init) => {
              await new Response(init!.body).arrayBuffer();
              return new Response(null, { status: 201 });
            },
          }),
        ).rejects.toThrow("CLOUD_INPUT_INVALID");
        expect(f.close).toHaveBeenCalledTimes(1);
      } finally {
        await f.source.file.close();
        await f.file.close();
      }
    },
  );
  it.each(["expiry", "owner", "info", "stream"] as const)(
    "closes the supplied reader on pre-fetch %s failure",
    async (failure) => {
      const f = await uploadFixture(),
        fetcher = vi.fn<typeof fetch>(),
        grant =
          failure === "expiry"
            ? {
                ...f.uploadGrant,
                expires_at: new Date(Date.now() - 1).toISOString(),
              }
            : f.uploadGrant;
      if (failure === "info")
        vi.spyOn(f.source.file, "info").mockRejectedValue(
          new Error("NATIVE_INFO_DENIED"),
        );
      if (failure === "stream")
        vi.spyOn(f.source.file, "chunks").mockImplementation(() => {
          throw new Error("NATIVE_STREAM_DENIED");
        });
      try {
        await expect(
          uploadCloudAudio(f.source, f.input, grant, {
            signal: new AbortController().signal,
            assertCurrent: () => {
              if (failure === "owner") throw new Error("ACCOUNT_CHANGED");
            },
            fetch: fetcher,
          }),
        ).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
        expect(f.close).toHaveBeenCalledTimes(1);
      } finally {
        await f.source.file.close();
        await f.file.close();
      }
    },
  );
  it("cancels a streaming upload and positively closes its retained reader", async () => {
    const f = await uploadFixture(
        Buffer.alloc(PRIVATE_FILE_CHUNK_BYTES * 8, 73),
      ),
      abort = new AbortController();
    try {
      await expect(
        uploadCloudAudio(f.source, f.input, f.uploadGrant, {
          signal: abort.signal,
          assertCurrent: () => {},
          fetch: async (_url, init) => {
            const reader = (
              init!.body as ReadableStream<Uint8Array>
            ).getReader();
            expect((await reader.read()).value?.length).toBe(
              PRIVATE_FILE_CHUNK_BYTES,
            );
            abort.abort();
            return new Response(null, { status: 201 });
          },
        }),
      ).rejects.toThrow("CANCELLED");
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(await readFile(f.source.path)).toEqual(f.bytes);
    } finally {
      await f.source.file.close();
      await f.file.close();
    }
  });
  it("preserves create-only412 handling and surfaces an unconfirmed reader close", async () => {
    const f = await uploadFixture(),
      original = f.release;
    f.close.mockImplementation(async () => {
      await original();
      throw new Error("NATIVE_CLOSE_UNCONFIRMED");
    });
    try {
      await expect(
        uploadCloudAudio(f.source, f.input, f.uploadGrant, {
          signal: new AbortController().signal,
          assertCurrent: () => {},
          fetch: async () => new Response(null, { status: 412 }),
        }),
      ).rejects.toThrow("NATIVE_CLOSE_UNCONFIRMED");
      expect(f.close).toHaveBeenCalledTimes(1);
    } finally {
      await f.file.close();
    }
    const valid = await uploadFixture();
    try {
      await uploadCloudAudio(valid.source, valid.input, valid.uploadGrant, {
        signal: new AbortController().signal,
        assertCurrent: () => {},
        fetch: async () => new Response(null, { status: 412 }),
      });
      expect(valid.close).toHaveBeenCalledTimes(1);
    } finally {
      await valid.file.close();
    }
  });
});
