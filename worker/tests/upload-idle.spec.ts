import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkerTransferClient } from "../src/runtime/transfers.js";

describe("upload inactivity protection with real HTTP", () => {
  for (const mode of [
    "headers-stall",
    "body-stall",
    "success",
    "cancel",
    "total-timeout",
  ] as const) {
    it(mode, async () => {
      const root = await mkdtemp(join(tmpdir(), "mw-upload-idle-"));
      const source = join(root, "vocals.mp3");
      const bytes = Buffer.alloc(mode === "body-stall" ? 20_000_000 : 1024, 1);
      await writeFile(source, bytes);
      const sha256 = createHash("sha256").update(bytes).digest("base64");
      const controller = new AbortController();
      const server = createServer((request, response) => {
        if (mode === "body-stall") {
          request.pause();
          return;
        }
        request.resume();
        request.on("end", () => {
          if (mode === "success") {
            response.writeHead(200, { "x-amz-version-id": "fixture-v1" });
            response.end();
          }
          if (mode === "cancel") controller.abort(new Error("owner cancelled"));
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No port");
        const client = new WorkerTransferClient({
          allowInsecureLoopback: true,
          uploadIdleTimeoutMs: mode === "total-timeout" ? 2000 : 250,
          timeoutMs: mode === "total-timeout" ? 150 : 3000,
        });
        const run = client.upload(
          {
            method: "PUT",
            url: `http://127.0.0.1:${address.port}/output`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            headers: {
              "Content-Type": "audio/mpeg",
              "If-None-Match": "*",
              "x-amz-checksum-sha256": sha256,
            },
          },
          source,
          { bytes: bytes.length, sha256, contentType: "audio/mpeg" },
          controller.signal,
        );
        if (mode === "success") await expect(run).resolves.toBe("fixture-v1");
        else if (mode === "cancel")
          await expect(run).rejects.toThrow("owner cancelled");
        else
          await expect(run).rejects.toMatchObject({
            code: "OUTPUT_UPLOAD_FAILED",
            retryable: true,
            diagnostic:
              mode === "total-timeout"
                ? "upload-total-timeout"
                : "upload-idle-timeout",
          });
        expect(
          createHash("sha256")
            .update(await readFile(source))
            .digest("base64"),
        ).toBe(sha256);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
