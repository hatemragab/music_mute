import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        "x-amz-checksum-sha256": digest,
        "If-None-Match": "*",
        "x-amz-storage-class": "INTELLIGENT_TIERING",
      });
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
