import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { downloadVerifiedArtifact } from "../src/enrollment/artifact-download.js";

const fault = vi.hoisted(() => ({ zeroWrite: false, writes: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const write = handle.write.bind(handle);
      handle.write = (async (
        buffer: Uint8Array,
        offset: number,
        length: number,
      ) => {
        fault.writes += 1;
        if (fault.zeroWrite) return { bytesWritten: 0, buffer };
        return write(buffer, offset, Math.min(length, 2));
      }) as typeof handle.write;
      return handle;
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  fault.zeroWrite = false;
  fault.writes = 0;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function options() {
  const root = await mkdtemp(join(tmpdir(), "artifact-fault-"));
  roots.push(root);
  await chmod(root, 0o700);
  const payload = Buffer.from("artifact-content");
  return {
    root,
    payload,
    download: {
      url: "https://owner.example/artifact",
      outputPath: join(root, "model"),
      expectedBytes: payload.length,
      expectedSha256: createHash("sha256").update(payload).digest("hex"),
      expectedContentType: "application/octet-stream",
    },
  };
}
it("completes short writes and reuses the verified cache without network access", async () => {
  const { payload, download } = await options();
  const fetchMock = vi.fn(
    async () =>
      new Response(payload, {
        headers: { "content-type": "application/octet-stream" },
      }),
  );
  await downloadVerifiedArtifact({ ...download, fetch: fetchMock });
  expect(fault.writes).toBeGreaterThan(1);
  expect(await readFile(download.outputPath)).toEqual(payload);
  await expect(
    downloadVerifiedArtifact({ ...download, fetch: fetchMock }),
  ).resolves.toMatchObject({ reused: true });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("fails zero-progress writes without activating or retaining partial data", async () => {
  const { root, payload, download } = await options();
  fault.zeroWrite = true;
  await expect(
    downloadVerifiedArtifact({
      ...download,
      fetch: async () =>
        new Response(payload, {
          headers: { "content-type": "application/octet-stream" },
        }),
    }),
  ).rejects.toThrow("no progress");
  expect(await readdir(root)).toEqual([]);
});
it("bounds a real HTTP body that stalls and cleans up its partial file", async () => {
  const { root, download } = await options();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write("a");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  try {
    await expect(
      downloadVerifiedArtifact({
        ...download,
        url: `http://127.0.0.1:${address.port}/artifact`,
        allowInsecureLoopback: true,
        idleTimeoutMs: 1000,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("does not reset the overall deadline across redirects and cancels redirect bodies", async () => {
  const { root, download } = await options();
  const cancelled = vi.fn();
  const signals: AbortSignal[] = [];
  const fetchMock: typeof fetch = async (_url, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error("Missing cancellation");
    signals.push(signal);
    await delay(650, undefined, { signal });
    return new Response(new ReadableStream({ cancel: cancelled }), {
      status: 302,
      headers: { location: "https://owner.example/next" },
    });
  };
  await expect(
    downloadVerifiedArtifact({
      ...download,
      fetch: fetchMock,
      timeoutMs: 1000,
      idleTimeoutMs: 5000,
      allowedRedirectHosts: ["owner.example"],
      maxRedirects: 4,
    }),
  ).rejects.toThrow();
  expect(signals).toHaveLength(2);
  expect(signals[0]).toBe(signals[1]);
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(await readdir(root)).toEqual([]);
});
it("cancels a body rejected by metadata validation", async () => {
  const { download } = await options();
  const cancelled = vi.fn();
  await expect(
    downloadVerifiedArtifact({
      ...download,
      fetch: async () =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { "content-type": "text/plain" },
        }),
    }),
  ).rejects.toThrow("type does not match");
  expect(cancelled).toHaveBeenCalledOnce();
});
