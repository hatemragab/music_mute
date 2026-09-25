import { createHash, randomUUID } from "node:crypto";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { IsolatedWorkerTransferClient } from "../src/runtime/isolated-transfers.js";
import { WorkspaceManager } from "../src/runtime/workspace.js";

for (const mode of ["success", "timeout", "cancel"] as const) {
  it(`isolated transfer ${mode} releases ownership before cleanup`, async () => {
    const root = await mkdtemp(join(tmpdir(), "mw-isolated-"));
    const manager = new WorkspaceManager(root);
    await manager.initialize();
    const workspace = await manager.create(randomUUID(), "audio/mpeg");
    const bytes = Buffer.from("controlled transfer fixture");
    const sha256 = createHash("sha256").update(bytes).digest("base64");
    const abort = new AbortController();
    const server = createServer((request, response) => {
      request.resume();
      if (mode === "cancel") abort.abort(new Error("fixture cancelled"));
      if (mode !== "success") return;
      if (request.method === "GET") response.end(bytes);
      else
        request.on("end", () => {
          response.writeHead(200, { "x-amz-version-id": "fixture-version" });
          response.end();
        });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const grant = {
        url: `http://127.0.0.1:${address.port}/fixture`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const client = new IsolatedWorkerTransferClient({
        workRoot: root,
        allowInsecureLoopback: true,
        timeoutMs: mode === "timeout" ? 1000 : 5000,
      });
      const expected = {
        key: "fixture",
        versionId: "fixture-version",
        bytes: bytes.length,
        sha256,
        contentType: "audio/mpeg" as const,
      };
      const run = client.download(
        grant,
        expected,
        workspace.input,
        abort.signal,
      );
      if (mode === "success") {
        await run;
        expect(await readFile(workspace.input)).toEqual(bytes);
        // The engine requires the directory to contain only its input.
        expect(await readdir(workspace.root)).toEqual([
          basename(workspace.input),
        ]);
        await expect(
          client.upload(
            {
              ...grant,
              method: "PUT",
              headers: {
                "Content-Type": "audio/mpeg",
                "If-None-Match": "*",
                "x-amz-checksum-sha256": sha256,
              },
            },
            workspace.input,
            expected,
          ),
        ).resolves.toBe("fixture-version");
      } else await expect(run).rejects.toThrow();
      if (mode === "success") {
        expect(await readdir(workspace.root)).toEqual([
          basename(workspace.input),
        ]);
      } else {
        const marker = JSON.parse(
          await readFile(join(workspace.root, "transfer-owner.json"), "utf8"),
        );
        expect(() => process.kill(marker.pid, 0)).toThrow();
      }
      await manager.cleanup(workspace);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  });
}

it("preserves a live file owner when termination cannot be confirmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "mw-isolated-owner-"));
  const manager = new WorkspaceManager(root);
  await manager.initialize();
  const workspace = await manager.create(randomUUID(), "audio/mpeg");
  let child: ChildProcess | undefined;
  let kill: ChildProcess["kill"] | undefined;
  const launch = (_path: string, _args: string[], options: ForkOptions) => {
    child = fork(
      fileURLToPath(
        new URL("./fixtures/blocked-transfer.mjs", import.meta.url),
      ),
      [],
      { ...options, execArgv: [] },
    );
    kill = child.kill.bind(child);
    child.kill = () => false;
    return child;
  };
  try {
    const client = new IsolatedWorkerTransferClient(
      { workRoot: root, timeoutMs: 1000, killTimeoutMs: 100 },
      launch,
    );
    await expect(
      client.download(
        {
          url: "https://example.invalid",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        {
          key: "fixture",
          versionId: "v1",
          bytes: 1,
          sha256: "unused",
          contentType: "audio/mpeg",
        },
        workspace.input,
      ),
    ).rejects.toMatchObject({
      diagnostic: "file-close-failed",
      retryable: false,
    });
    await expect(manager.cleanup(workspace)).rejects.toThrow("still owns");
    await expect(new WorkspaceManager(root).initialize()).rejects.toThrow(
      "still owns",
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      kill?.("SIGKILL");
      await exited;
    }
    await manager.cleanup(workspace);
    await rm(root, { recursive: true, force: true });
  }
});
