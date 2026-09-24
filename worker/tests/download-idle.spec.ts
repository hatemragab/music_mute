import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkerTransferClient } from "../src/runtime/transfers.js";

describe("download inactivity protection", () => {
  for (const mode of [
    "headers-stall",
    "body-stall",
    "progress",
    "existing-file",
  ] as const) {
    it(mode, async () => {
      const root = await mkdtemp(join(tmpdir(), "mw-idle-"));
      const target = join(root, "input.mp3");
      const body = Buffer.from("abcdef");
      const server = createServer((_request, response) => {
        if (mode === "headers-stall") return;
        response.writeHead(200, {
          "Content-Length": body.length,
          "Content-Type": "audio/mpeg",
        });
        if (mode === "body-stall") {
          response.write(body.subarray(0, 1));
          return;
        }
        if (mode === "existing-file") {
          response.end(body);
          return;
        }
        let offset = 0;
        const timer = setInterval(() => {
          response.write(body.subarray(offset, ++offset));
          if (offset === body.length) {
            clearInterval(timer);
            response.end();
          }
        }, 80);
        response.on("close", () => clearInterval(timer));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No port");
        if (mode === "existing-file") await writeFile(target, "preserve");
        const client = new WorkerTransferClient({
          allowInsecureLoopback: true,
          downloadIdleTimeoutMs: 250,
          timeoutMs: 2000,
        });
        const run = client.download(
          {
            url: `http://127.0.0.1:${address.port}/input`,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
          {
            key: "input",
            versionId: "v1",
            contentType: "audio/mpeg",
            bytes: body.length,
            sha256: createHash("sha256").update(body).digest("base64"),
          },
          target,
        );
        if (mode === "progress") {
          await run;
          expect(await readFile(target)).toEqual(body);
        } else if (mode === "existing-file") {
          await expect(run).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
          expect(await readFile(target, "utf8")).toBe("preserve");
        } else {
          await expect(run).rejects.toMatchObject({
            code: "DOWNLOAD_FAILED",
            retryable: true,
            diagnostic: "download-idle-timeout",
          });
          await expect(readFile(target)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
