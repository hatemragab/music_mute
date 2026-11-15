import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TransferError,
  WorkerTransferClient,
} from "../src/runtime/transfers.js";

const roots: string[] = [];
const future = () => new Date(Date.now() + 60_000).toISOString();

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("worker transfers", () => {
  it("allows a bounded timeout override for focused failure handling", async () => {
    const client = new WorkerTransferClient({
      fetch: vi.fn(
        async (_input: unknown, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      ) as unknown as typeof fetch,
      allowInsecureLoopback: true,
      timeoutMs: 100,
    });
    const root = await mkdtemp(join(tmpdir(), "musicmute-transfer-"));
    roots.push(root);
    const destination = join(root, "input.mp3");

    await expect(
      client.download(
        { url: "http://127.0.0.1/input", expiresAt: future() },
        {
          key: "input/source.mp3",
          versionId: "v1",
          bytes: 1,
          sha256: createHash("sha256").update("x").digest("base64"),
          contentType: "audio/mpeg",
        },
        destination,
      ),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", retryable: true });
  });

  it("streams an exact input to a new file and verifies its identity", async () => {
    const body = Buffer.from("bounded-input");
    const fetchMock = vi.fn(
      async (_input: unknown, _init?: RequestInit) =>
        new Response(body, {
          status: 200,
          headers: {
            "Content-Length": String(body.length),
            "Content-Type": "audio/mpeg",
          },
        }),
    );
    const root = await mkdtemp(join(tmpdir(), "musicmute-transfer-"));
    roots.push(root);
    const destination = join(root, "input.mp3");
    const client = new WorkerTransferClient({
      fetch: fetchMock as unknown as typeof fetch,
      allowInsecureLoopback: true,
    });

    await client.download(
      { url: "http://127.0.0.1/input", expiresAt: future() },
      {
        key: "input/source.mp3",
        versionId: "v1",
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("base64"),
        contentType: "audio/mpeg",
      },
      destination,
    );

    expect(await readFile(destination)).toEqual(body);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
    });
  });

  it("uploads only exact signed headers and requires an immutable version", async () => {
    const body = Buffer.from("bounded-output");
    const digest = createHash("sha256").update(body).digest("base64");
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        "Content-Type": "audio/mpeg",
        "Content-Length": String(body.length),
        "x-amz-checksum-sha256": digest,
        "If-None-Match": "*",
        "x-amz-storage-class": "INTELLIGENT_TIERING",
      });
      const chunks: Buffer[] = [];
      for await (const chunk of init!.body as unknown as AsyncIterable<Buffer>)
        chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(body);
      return new Response(null, {
        status: 200,
        headers: { "x-amz-version-id": "output-version" },
      });
    });
    const root = await mkdtemp(join(tmpdir(), "musicmute-transfer-"));
    roots.push(root);
    const source = join(root, "vocals.mp3");
    await writeFile(source, body, { mode: 0o600 });
    const client = new WorkerTransferClient({
      fetch: fetchMock as unknown as typeof fetch,
      allowInsecureLoopback: true,
    });

    await expect(
      client.upload(
        {
          method: "PUT",
          url: "http://127.0.0.1/output",
          expiresAt: future(),
          headers: {
            "Content-Type": "audio/mpeg",
            "x-amz-checksum-sha256": digest,
            "If-None-Match": "*",
            "x-amz-storage-class": "INTELLIGENT_TIERING",
          },
        },
        source,
        { bytes: body.length, sha256: digest, contentType: "audio/mpeg" },
      ),
    ).resolves.toBe("output-version");
  });

  it("starts PUT before reading the full output and rejects corruption before the last chunk", async () => {
    const data = Buffer.alloc(256 * 1024, 7);
    const root = await mkdtemp(join(tmpdir(), "musicmute-transfer-"));
    roots.push(root);
    const source = join(root, "vocals.mp3");
    await writeFile(source, data);
    const digest = createHash("sha256")
      .update(Buffer.alloc(data.length, 8))
      .digest("base64");
    let received = 0;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.body).not.toBeInstanceOf(Buffer);
      for await (const chunk of init!.body as unknown as AsyncIterable<Buffer>)
        received += chunk.length;
      throw new Error("Corrupt stream must never complete");
    });
    const client = new WorkerTransferClient({
      fetch: fetchMock as typeof fetch,
      allowInsecureLoopback: true,
    });
    await expect(
      client.upload(
        {
          method: "PUT",
          url: "http://127.0.0.1/output",
          expiresAt: future(),
          headers: {
            "Content-Type": "audio/mpeg",
            "x-amz-checksum-sha256": digest,
            "If-None-Match": "*",
          },
        },
        source,
        { bytes: data.length, sha256: digest, contentType: "audio/mpeg" },
      ),
    ).rejects.toMatchObject({
      diagnostic: "output-checksum-mismatch",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThan(data.length);
  });

  it("reopens a fresh stream on retry and refuses symlink outputs", async () => {
    const data = Buffer.alloc(128 * 1024, 7);
    const digest = createHash("sha256").update(data).digest("base64");
    const root = await mkdtemp(join(tmpdir(), "musicmute-transfer-"));
    roots.push(root);
    const source = join(root, "vocals.mp3");
    await writeFile(source, data);
    const link = join(root, "link.mp3");
    await symlink(source, link);
    let calls = 0;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (++calls === 1) return new Response(null, { status: 503 });
      const chunks: Buffer[] = [];
      for await (const chunk of init!.body as unknown as AsyncIterable<Buffer>)
        chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(data);
      return new Response(null, {
        headers: { "x-amz-version-id": "retry-version" },
      });
    });
    const client = new WorkerTransferClient({
      fetch: fetchMock as typeof fetch,
      allowInsecureLoopback: true,
    });
    const grant = {
      method: "PUT" as const,
      url: "http://127.0.0.1/output",
      expiresAt: future(),
      headers: {
        "Content-Type": "audio/mpeg",
        "x-amz-checksum-sha256": digest,
        "If-None-Match": "*",
      },
    };
    const expected = {
      bytes: data.length,
      sha256: digest,
      contentType: "audio/mpeg" as const,
    };
    await expect(client.upload(grant, link, expected)).rejects.toBeInstanceOf(
      TransferError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(client.upload(grant, source, expected)).rejects.toMatchObject({
      retryable: true,
    });
    await expect(client.upload(grant, source, expected)).resolves.toBe(
      "retry-version",
    );
  });

  it("rejects an unexpected signed storage class before upload", async () => {
    const body = Buffer.from("bounded-output");
    const digest = createHash("sha256").update(body).digest("base64");
    const root = await mkdtemp(join(tmpdir(), "musicmute-transfer-"));
    roots.push(root);
    const source = join(root, "vocals.mp3");
    await writeFile(source, body, { mode: 0o600 });
    const fetchMock = vi.fn();
    const client = new WorkerTransferClient({
      fetch: fetchMock as unknown as typeof fetch,
      allowInsecureLoopback: true,
    });

    await expect(
      client.upload(
        {
          method: "PUT",
          url: "http://127.0.0.1/output",
          expiresAt: future(),
          headers: {
            "Content-Type": "audio/mpeg",
            "x-amz-checksum-sha256": digest,
            "If-None-Match": "*",
            "x-amz-storage-class": "STANDARD",
          },
        },
        source,
        { bytes: body.length, sha256: digest, contentType: "audio/mpeg" },
      ),
    ).rejects.toMatchObject({
      code: "OUTPUT_UPLOAD_FAILED",
      retryable: false,
      diagnostic: "upload-header-mismatch",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records only the rejected upload status in its private diagnostic", async () => {
    const body = Buffer.from("bounded-output");
    const digest = createHash("sha256").update(body).digest("base64");
    const root = await mkdtemp(join(tmpdir(), "musicmute-transfer-"));
    roots.push(root);
    const source = join(root, "vocals.mp3");
    await writeFile(source, body, { mode: 0o600 });
    const client = new WorkerTransferClient({
      fetch: vi.fn(
        async () => new Response(null, { status: 403 }),
      ) as unknown as typeof fetch,
      allowInsecureLoopback: true,
    });

    await expect(
      client.upload(
        {
          method: "PUT",
          url: "http://127.0.0.1/output",
          expiresAt: future(),
          headers: {
            "Content-Type": "audio/mpeg",
            "x-amz-checksum-sha256": digest,
            "If-None-Match": "*",
          },
        },
        source,
        { bytes: body.length, sha256: digest, contentType: "audio/mpeg" },
      ),
    ).rejects.toMatchObject({
      code: "OUTPUT_UPLOAD_FAILED",
      retryable: false,
      diagnostic: "upload-http-403",
    });
  });

  it("rejects redirects and removes a partial input", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-transfer-"));
    roots.push(root);
    const destination = join(root, "input.mp3");
    const client = new WorkerTransferClient({
      fetch: vi.fn(
        async () => new Response(null, { status: 302 }),
      ) as unknown as typeof fetch,
      allowInsecureLoopback: true,
    });

    await expect(
      client.download(
        { url: "http://127.0.0.1/input", expiresAt: future() },
        {
          key: "input/source.mp3",
          versionId: "v1",
          bytes: 1,
          sha256: createHash("sha256").update("x").digest("base64"),
          contentType: "audio/mpeg",
        },
        destination,
      ),
    ).rejects.toBeInstanceOf(TransferError);
    await expect(readFile(destination)).rejects.toThrow();
  });
});
