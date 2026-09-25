import { createHash } from "node:crypto";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  TransferOwnershipError,
  WorkerTransferClient,
} from "../src/runtime/transfers.js";
const fault = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  entered: () => {},
  closeFails: false,
  closes: [] as Array<() => Promise<void>>,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const write = handle.write.bind(handle);
      const close = handle.close.bind(handle);
      fault.closes.push(close);
      handle.write = (async (
        buffer: Uint8Array,
        offset: number,
        length: number,
      ) => {
        fault.entered();
        if (fault.gate) await fault.gate;
        return write(buffer, offset, length);
      }) as typeof handle.write;
      handle.close = async () => {
        if (fault.closeFails)
          throw Object.assign(new Error("injected close failure"), {
            code: "EIO",
          });
        await close();
      };
      return handle;
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  fault.closeFails = false;
  fault.gate = null;
  fault.entered = () => {};
  await Promise.all(
    fault.closes.splice(0).map((close) => close().catch(() => {})),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "transfer-fs-"));
  roots.push(root);
  const target = join(root, "input.mp3");
  const bytes = Buffer.from("fixture");
  const client = new WorkerTransferClient({
    fetch: async () => new Response(bytes),
    timeoutMs: 5000,
  });
  const run = (signal?: AbortSignal) =>
    client.download(
      {
        url: "https://storage.example/input",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      {
        key: "input.mp3",
        versionId: "v1",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("base64"),
        contentType: "audio/mpeg",
      },
      target,
      signal,
    );
  return { target, run };
}
it("does not unlink a pending write and rejects cancellation after the write settles", async () => {
  const f = await fixture();
  let release!: () => void;
  fault.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    fault.entered = resolve;
  });
  const abort = new AbortController();
  let settled = false;
  const run = f.run(abort.signal);
  void run.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const safety = setTimeout(() => release(), 1000);
  await entered;
  abort.abort(new Error("lease lost"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  expect((await lstat(f.target)).isFile()).toBe(true);
  release();
  clearTimeout(safety);
  await expect(run).rejects.toThrow("lease lost");
  await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
});
it("preserves the file and reports uncertain ownership when closure fails", async () => {
  const f = await fixture();
  fault.closeFails = true;
  await expect(f.run()).rejects.toBeInstanceOf(TransferOwnershipError);
  expect((await lstat(f.target)).isFile()).toBe(true);
});
