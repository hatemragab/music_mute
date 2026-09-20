import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildResponse } from "../src/agent/ipc/child-protocol.js";
import { WorkerControlPlaneClient } from "../src/runtime/control-plane-client.js";
import type { WorkerRecipeSnapshot } from "../src/runtime/contracts.js";
import { WorkerTransferClient } from "../src/runtime/transfers.js";
import { WorkerRuntime } from "../src/runtime/worker-runtime.js";

const machineId = "cb56441d-f2df-4b44-a320-6f37dfa81f7f";
const workerId = "a69d3899-2214-4427-98cf-b9a4449aeae1";
const attemptId = "99f8016b-67f3-4f4b-beb4-205a7b87147e";
const credential = "x".repeat(43);
const input = Buffer.from("http-input");
const output = Buffer.from("http-output");
const inputSha = createHash("sha256").update(input).digest("base64");
const outputSha = createHash("sha256").update(output).digest("base64");
const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

const recipe: WorkerRecipeSnapshot = {
  recipeId: "kim-vocals-trim-v1",
  recipeRevision: 1,
  protocolVersion: 1,
  recipeDigest: "a".repeat(64),
  modelFilename: "Kim_Vocal_2.onnx",
  modelDigest: "b".repeat(64),
  modelBytes: 66_759_214,
  preparationProfileId: "pcm16-stereo-44100-v1",
  stepIds: [
    "prepare-pcm16-stereo-44100-v1",
    "separate-kim-vocal-2-v1",
    "trim-vocal-gaps-v1",
    "encode-mp3-192k-v1",
    "validate-audio-v1",
  ],
  trimEnabled: true,
  denoiseEnabled: false,
  denoisePresetId: null,
  trimProfileId: "trim-vocal-gaps-v1",
  outputFormat: "mp3",
  outputBitrateKbps: 192,
};

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolveClose) =>
            server.close(() => resolveClose()),
          ),
      ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

class HttpFixtureChild {
  processing = false;

  async request(
    _command: "ping" | "process",
    payload: Record<string, unknown>,
  ): Promise<ChildResponse> {
    this.processing = true;
    const outputPath = join(
      String(payload.attemptDirectory),
      "output",
      "vocals.mp3",
    );
    await mkdir(dirname(outputPath));
    await writeFile(outputPath, output, { mode: 0o600 });
    this.processing = false;
    return {
      protocolVersion: 1,
      type: "result",
      requestId: randomUUID(),
      incarnation: randomUUID(),
      sentAt: new Date().toISOString(),
      payload: {
        attemptId,
        outputPath,
        bytes: output.length,
        sha256: outputSha,
        contentType: "audio/mpeg",
        measuredOutputDurationSeconds: 1,
        recipeId: recipe.recipeId,
        recipeRevision: recipe.recipeRevision,
        recipeDigest: recipe.recipeDigest,
        modelDigest: recipe.modelDigest,
        trimEnabled: recipe.trimEnabled,
        denoiseEnabled: recipe.denoiseEnabled,
        outputFormat: recipe.outputFormat,
        outputBitrateKbps: recipe.outputBitrateKbps,
      },
    };
  }

  terminateActive(): void {
    this.processing = false;
  }

  isProcessing(): boolean {
    return this.processing;
  }
}

describe("worker runtime HTTP integration", () => {
  it("executes the authoritative HTTPS shape and scoped transfer sequence", async () => {
    const transitions: string[] = [];
    const started = Date.now();
    let origin = "";
    let claimed = false;
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", origin);
        if (url.pathname.startsWith("/api/v1/worker/")) {
          if (request.headers.authorization !== `Bearer ${credential}`)
            return sendJson(response, 401, { code: "WORKER_UNAUTHENTICATED" });
          const body = request.method === "POST" ? await jsonBody(request) : {};
          if (url.pathname === "/api/v1/worker/v1/session") {
            transitions.push("session");
            return sendJson(response, 200, {
              machineId,
              policyRevision: 1,
              serverTime: new Date(started).toISOString(),
            });
          }
          if (url.pathname === "/api/v1/worker/v1/config") {
            transitions.push("config");
            return sendJson(response, 200, {
              machineId,
              machineStatus: "active",
              desiredRevision: 1,
              appliedRevision: 1,
              claimAllowed: true,
              policy: {
                revision: 1,
                acceptClaims: true,
                recipes: [
                  {
                    recipeId: recipe.recipeId,
                    enabled: true,
                    maxSlotsPerMachine: 1,
                  },
                ],
                leaseSeconds: 90,
                processingDeadlineSeconds: 300,
                maxAttempts: 3,
              },
              compatibleRelease: null,
              commands: [],
              serverTime: new Date().toISOString(),
            });
          }
          if (url.pathname === "/api/v1/worker/v1/slots") {
            transitions.push("slot");
            return sendJson(response, 200, {
              workerId,
              state: "idle",
              revision: 0,
              serverTime: new Date().toISOString(),
            });
          }
          if (url.pathname === "/api/v1/worker/v1/claims") {
            transitions.push("claim");
            if (claimed)
              return sendJson(response, 200, {
                claim: null,
                serverTime: new Date().toISOString(),
              });
            claimed = true;
            return sendJson(response, 200, {
              claim: {
                attemptId,
                jobId: "64b000000000000000000001",
                attemptNumber: 1,
                leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
                deadlineAt: new Date(Date.now() + 300_000).toISOString(),
                input: {
                  key: "input/source.mp3",
                  versionId: "input-version",
                  bytes: input.length,
                  sha256: inputSha,
                  contentType: "audio/mpeg",
                },
                recipe,
                replayed: false,
              },
              serverTime: new Date().toISOString(),
            });
          }
          if (url.pathname.endsWith("/input-grant")) {
            transitions.push("input-grant");
            return sendJson(response, 200, {
              requestId: body.requestId,
              attemptId,
              object: {
                key: "input/source.mp3",
                versionId: "input-version",
                bytes: input.length,
                sha256: inputSha,
                contentType: "audio/mpeg",
              },
              grant: {
                url: `${origin}/storage/input?versionId=input-version`,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            });
          }
          if (url.pathname.endsWith("/output-grant")) {
            transitions.push("output-grant");
            return sendJson(response, 200, {
              requestId: body.requestId,
              attemptId,
              reservation: {
                key: `worker-jobs/64b000000000000000000001/attempts/${attemptId}/vocals.mp3`,
                bytes: output.length,
                sha256: outputSha,
                contentType: "audio/mpeg",
                measuredDurationSeconds: 1,
              },
              grant: {
                method: "PUT",
                url: `${origin}/storage/output`,
                headers: {
                  "Content-Type": "audio/mpeg",
                  "x-amz-checksum-sha256": outputSha,
                  "If-None-Match": "*",
                },
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
              object: null,
            });
          }
          if (url.pathname.endsWith("/complete")) {
            transitions.push("complete");
            expect(body.versionId).toBe("output-version");
            return sendJson(response, 200, {
              attemptId,
              jobId: "64b000000000000000000001",
              status: "ready",
              replayed: false,
            });
          }
        }
        if (url.pathname === "/storage/input") {
          transitions.push("download");
          response.writeHead(200, {
            "Content-Type": "audio/mpeg",
            "Content-Length": input.length,
          });
          return response.end(input);
        }
        if (url.pathname === "/storage/output") {
          transitions.push("upload");
          expect(request.headers["if-none-match"]).toBe("*");
          expect(request.headers["x-amz-checksum-sha256"]).toBe(outputSha);
          expect(await rawBody(request)).toEqual(output);
          response.writeHead(200, { "x-amz-version-id": "output-version" });
          return response.end();
        }
        sendJson(response, 404, { code: "NOT_FOUND" });
      } catch {
        sendJson(response, 500, { code: "HARNESS_FAILED" });
      }
    });
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", () => resolveListen()),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test port");
    origin = `http://127.0.0.1:${address.port}`;

    const root = await mkdtemp(join(tmpdir(), "musicmute-http-runtime-"));
    roots.push(root);
    const child = new HttpFixtureChild();
    const supervisor = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      child: vi.fn(() => child),
      restart: vi.fn(async () => child),
    };
    const runtime = new WorkerRuntime(
      {
        machineId,
        slots: [
          {
            workerId,
            gpuId: "gpu-0",
            slotIndex: 0,
            recipeIds: [recipe.recipeId],
            provider: "coreml",
          },
        ],
        workRoot: join(root, "attempts"),
        modelCacheRoot: join(root, "models"),
        ffmpegPath: "/usr/local/bin/ffmpeg",
        ffprobePath: "/usr/local/bin/ffprobe",
        resources: { assertAvailable: vi.fn(async () => undefined) },
      },
      new WorkerControlPlaneClient({
        baseUrl: `${origin}/api/v1`,
        credential,
        allowInsecureLoopback: true,
      }),
      new WorkerTransferClient({ allowInsecureLoopback: true }),
      supervisor,
    );

    await runtime.start();
    await runtime.reconcileOnce();
    await runtime.waitForIdle();
    await runtime.stop();

    expect(transitions).toEqual([
      "session",
      "config",
      "slot",
      "config",
      "claim",
      "input-grant",
      "download",
      "output-grant",
      "upload",
      "complete",
    ]);
  });
});

async function jsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  return JSON.parse((await rawBody(request)).toString("utf8")) as Record<
    string,
    unknown
  >;
}

async function rawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk as Uint8Array);
    total += value.length;
    if (total > 64 * 1024) throw new Error("request too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
