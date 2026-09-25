import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runEnrollmentCommand,
  runInstallationPreparationCommand,
} from "../src/enrollment/cli.js";
import {
  assertInstallationReport,
  WorkerEnrollmentClient,
  type WorkerEnrollmentError,
  type WorkerInstallationReport,
} from "../src/enrollment/enrollment-client.js";
import { readInstallationArtifactsReceipt } from "../src/enrollment/installation-receipt.js";
import { writeMacReleaseManifest } from "../src/platform/macos/release-manifest.js";
import { fromWireCase, toWireCase } from "../src/runtime/wire-case.js";

const execFile = promisify(execFileCallback);

const enrollmentCredential = "e".repeat(43);
const installationCredential = "i".repeat(43);
const installationId = "bfcd61be-0dd8-47af-889e-5c4aa035fa84";
const machineId = "cb56441d-f2df-4b44-a320-6f37dfa81f7f";
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("worker enrollment client", () => {
  it("requires the API origin without a route prefix", () => {
    expect(
      () =>
        new WorkerEnrollmentClient({
          baseUrl: "https://workers.example.invalid/old-prefix",
        }),
    ).toThrow("API origin");
  });

  it("surfaces a rate limit whose Retry-After exceeds the retry ceiling", async () => {
    const fetchMock = vi.fn(async () =>
      problem("WORKER_RATE_LIMITED", 429, { "Retry-After": "60" }),
    );
    const client = new WorkerEnrollmentClient({
      baseUrl: "http://127.0.0.1",
      allowInsecureLoopback: true,
      fetch: fetchMock as unknown as typeof fetch,
      maxAttempts: 3,
    });

    await expect(
      client.exchange(
        enrollmentCredential,
        "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
      ),
    ).rejects.toMatchObject({
      code: "WORKER_RATE_LIMITED",
      status: 429,
      retryable: true,
      retryAfterMs: 60_000,
    } satisfies Partial<WorkerEnrollmentError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not decode legacy JSON errors as problem details", async () => {
    const client = new WorkerEnrollmentClient({
      baseUrl: "http://127.0.0.1",
      allowInsecureLoopback: true,
      fetch: vi.fn(async () =>
        json({ code: "WORKER_FORBIDDEN", message: "legacy" }, 403),
      ) as unknown as typeof fetch,
      maxAttempts: 1,
    });

    await expect(
      client.exchange(
        enrollmentCredential,
        "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
      ),
    ).rejects.toMatchObject({ code: "HTTP_403", status: 403 });
  });

  it("retries enrollment after a short Retry-After", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        problem("WORKER_RATE_LIMITED", 429, { "Retry-After": "0" }),
      )
      .mockResolvedValueOnce(
        json({
          installationId,
          phase: "restricted",
          expiresAt: "2026-09-19T20:00:00.000Z",
          credential: installationCredential,
          replayed: true,
        }),
      );
    const client = new WorkerEnrollmentClient({
      baseUrl: "http://127.0.0.1",
      allowInsecureLoopback: true,
      fetch: fetchMock as unknown as typeof fetch,
      maxAttempts: 2,
    });

    await expect(
      client.exchange(
        enrollmentCredential,
        "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
      ),
    ).resolves.toMatchObject({ installationId });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transient exchange with the same request body", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1)
        return problem("WORKER_DEPENDENCY_UNAVAILABLE", 503);
      return json({
        installationId,
        phase: "restricted",
        expiresAt: "2026-09-19T20:00:00.000Z",
        credential: installationCredential,
        replayed: true,
      });
    });
    const client = new WorkerEnrollmentClient({
      baseUrl: "http://127.0.0.1",
      allowInsecureLoopback: true,
      fetch: fetchMock as unknown as typeof fetch,
      maxAttempts: 2,
    });
    const requestId = "32410a14-e85a-4a1d-bb99-61fa54b07eaa";

    await expect(
      client.exchange(enrollmentCredential, requestId),
    ).resolves.toMatchObject({ installationId, replayed: true });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]!) as unknown).toEqual({
      request_id: requestId,
    });
  });

  it("requests and strictly validates installation artifact grants", async () => {
    const requests: Array<{
      url: string;
      authorization: string | undefined;
      body: unknown;
    }> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          authorization:
            new Headers(init?.headers).get("authorization") ?? undefined,
          body: JSON.parse(String(init?.body)) as unknown,
        });
        return json(artifactManifest("darwin-arm64"));
      },
    );
    const client = new WorkerEnrollmentClient({
      baseUrl: "http://127.0.0.1",
      allowInsecureLoopback: true,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.artifacts(installationId, installationCredential, "darwin-arm64"),
    ).resolves.toEqual(artifactManifest("darwin-arm64"));
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1/worker/installations/${installationId}/artifacts`,
        authorization: `Bearer ${installationCredential}`,
        body: { platform: "darwin-arm64" },
      },
    ]);
  });

  it("accepts future fields in enrollment responses while validating required artifact fields", async () => {
    const manifest = artifactManifest("darwin-arm64");
    const client = new WorkerEnrollmentClient({
      baseUrl: "https://workers.example.invalid",
      fetch: (async () =>
        json({
          ...manifest,
          future_field: "new server field",
          release: { ...manifest.release, future_field: true },
          model: { ...manifest.model, future_field: { nested_value: 1 } },
          fixture: { ...manifest.fixture, future_field: null },
        })) as typeof fetch,
      maxAttempts: 1,
    });

    await expect(
      client.artifacts(installationId, installationCredential, "darwin-arm64"),
    ).resolves.toEqual(manifest);
  });

  it("keeps installation report request fields exact", () => {
    expect(() =>
      assertInstallationReport({
        ...report(),
        futureField: true,
      } as unknown as WorkerInstallationReport),
    ).toThrow("unknown field");
  });

  it.each([
    [
      "a changed platform",
      { ...artifactManifest("darwin-arm64"), platform: "windows-amd64" },
      "platform changed",
    ],
    [
      "an insecure artifact URL",
      {
        ...artifactManifest("darwin-arm64"),
        model: {
          ...artifactManifest("darwin-arm64").model,
          url: "http://storage.example.invalid/model",
        },
      },
      "URL is unsafe",
    ],
    [
      "conflicting filenames",
      {
        ...artifactManifest("darwin-arm64"),
        fixture: {
          ...artifactManifest("darwin-arm64").fixture,
          filename: "kim-vocal-2.onnx",
        },
      },
      "filenames conflict",
    ],
  ])("rejects artifact responses with %s", async (_name, response, message) => {
    const client = new WorkerEnrollmentClient({
      baseUrl: "https://workers.example.invalid",
      fetch: (async () => json(response)) as typeof fetch,
      maxAttempts: 1,
    });

    await expect(
      client.artifacts(installationId, installationCredential, "darwin-arm64"),
    ).rejects.toThrow(message);
  });

  it("validates qualification upload grants and confirmations", async () => {
    const outputDigest = "b".repeat(64);
    const checksum = Buffer.from(outputDigest, "hex").toString("base64");
    const grantRequestId = "98f06f56-80f7-4f48-a0fe-a731f8678e30";
    const confirmRequestId = "92e0a366-6f0c-475f-84ce-e0cd5a0c919f";
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = new WorkerEnrollmentClient({
      baseUrl: "https://workers.example.invalid",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, body: JSON.parse(String(init?.body)) as unknown });
        if (url.endsWith("/qualification-output-grants"))
          return json({
            requestId: grantRequestId,
            reservation: {
              bytes: 1234,
              sha256: outputDigest,
              contentType: "audio/mpeg",
            },
            grant: {
              method: "PUT",
              url: "https://storage.example.invalid/output?signature=one",
              headers: {
                "Content-Type": "audio/mpeg",
                "x-amz-checksum-sha256": checksum,
                "If-None-Match": "*",
              },
              expiresAt: "2099-09-20T12:00:00.000Z",
            },
            confirmed: false,
          });
        return json({
          requestId: confirmRequestId,
          confirmed: true,
          replayed: false,
        });
      }) as typeof fetch,
    });

    await expect(
      client.qualificationUploadGrant(
        installationId,
        installationCredential,
        grantRequestId,
        1234,
        outputDigest,
      ),
    ).resolves.toMatchObject({ confirmed: false });
    await expect(
      client.confirmQualificationUpload(
        installationId,
        installationCredential,
        confirmRequestId,
        "version-1",
      ),
    ).resolves.toEqual({
      requestId: confirmRequestId,
      confirmed: true,
      replayed: false,
    });
    expect(requests.map((request) => request.body)).toEqual([
      { request_id: grantRequestId, bytes: 1234, sha256: outputDigest },
      { request_id: confirmRequestId, version_id: "version-1" },
    ]);
  });

  it("runs and safely replays the complete restricted enrollment sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-enrollment-"));
    roots.push(root);
    const output = join(root, "protected");
    await mkdir(output, { mode: 0o700 });
    await chmod(output, 0o700);
    const enrollmentFile = join(root, "enrollment.credential");
    await writeFile(enrollmentFile, `${enrollmentCredential}\n`, {
      mode: 0o600,
    });
    await chmod(enrollmentFile, 0o600);
    const reportFile = join(root, "report.json");
    await writeFile(reportFile, JSON.stringify(report()), { mode: 0o600 });
    const requests: Array<{
      path: string;
      authorization: string | undefined;
      body: Record<string, unknown>;
    }> = [];
    let activated = false;
    const server = createServer((request, response) => {
      void handleRequest(
        request,
        response,
        requests,
        () => activated,
        () => {
          activated = true;
        },
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Test server address is unavailable");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const arguments_ = [
      "--backend-url",
      `http://127.0.0.1:${address.port}`,
      "--enrollment-file",
      enrollmentFile,
      "--report",
      reportFile,
      "--output",
      output,
      "--allow-insecure-loopback",
      "true",
    ];
    try {
      await runEnrollmentCommand(arguments_);
      await runEnrollmentCommand(arguments_);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(requests.map((request) => request.path)).toEqual([
      "/worker/installations",
      `/worker/installations/${installationId}/reports`,
      `/worker/installations/${installationId}/activations`,
      "/worker/installations",
      `/worker/installations/${installationId}/activations`,
    ]);
    expect(requests[0]?.authorization).toBe(`Bearer ${enrollmentCredential}`);
    expect(requests[3]?.authorization).toBe(`Bearer ${enrollmentCredential}`);
    expect(
      [requests[1], requests[2], requests[4]].every(
        (request) =>
          request?.authorization === `Bearer ${installationCredential}`,
      ),
    ).toBe(true);
    expect(requests[0]?.body.requestId).toBe(requests[3]?.body.requestId);
    expect(requests[2]?.body.requestId).toBe(requests[4]?.body.requestId);
    const machineCredential = (
      await readFile(join(output, "machine.credential"), "utf8")
    ).trim();
    expect(machineCredential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const credentialDigest = createHash("sha256")
      .update(machineCredential)
      .digest("hex");
    expect(requests[2]?.body.credentialDigest).toBe(credentialDigest);
    expect(requests[4]?.body.credentialDigest).toBe(credentialDigest);
    expect(
      JSON.parse(await readFile(join(output, "machine.json"), "utf8")),
    ).toMatchObject({ machineId, credentialRevision: 1 });
    if (process.platform !== "win32") {
      expect(
        (await stat(join(output, "machine.credential"))).mode & 0o777,
      ).toBe(0o600);
      expect(
        (await stat(join(output, ".enrollment-state.json"))).mode & 0o777,
      ).toBe(0o600);
    }
    expect(log.mock.calls.flat().join(" ")).not.toContain(machineCredential);
    expect(log.mock.calls.flat().join(" ")).not.toContain(
      installationCredential,
    );
  });

  it("prepares and safely reuses the approved installation artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-preparation-"));
    roots.push(root);
    const output = join(root, "protected");
    await mkdir(output, { mode: 0o700 });
    await chmod(output, 0o700);
    const enrollmentFile = join(root, "enrollment.credential");
    await writeFile(enrollmentFile, `${enrollmentCredential}\n`, {
      mode: 0o600,
    });
    await chmod(enrollmentFile, 0o600);
    const payloads = {
      release: await createMacReleaseArchive(root),
      model: Buffer.from("approved model"),
      fixture: Buffer.from("approved fixture"),
    };
    const artifactRequests = new Map<string, number>();
    const exchangeBodies: unknown[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method === "GET") {
          const name = new URL(
            request.url ?? "/",
            "http://127.0.0.1",
          ).pathname.slice(1) as keyof typeof payloads;
          const payload = payloads[name];
          if (payload === undefined) {
            response.writeHead(404).end();
            return;
          }
          artifactRequests.set(name, (artifactRequests.get(name) ?? 0) + 1);
          const contentType =
            name === "release"
              ? "application/gzip"
              : name === "model"
                ? "application/octet-stream"
                : "audio/wav";
          response.writeHead(200, {
            "Content-Length": payload.length,
            "Content-Type": contentType,
          });
          response.end(payload);
          return;
        }
        const body = JSON.parse(await readBody(request)) as unknown;
        if (request.url === "/worker/installations") {
          exchangeBodies.push(body);
          send(response, {
            installationId,
            phase: "restricted",
            expiresAt: "2099-09-20T12:00:00.000Z",
            credential: installationCredential,
            replayed: exchangeBodies.length > 1,
          });
          return;
        }
        if (request.url?.endsWith("/artifacts")) {
          const address = server.address();
          if (address === null || typeof address === "string")
            throw new Error("Test server address is unavailable");
          send(
            response,
            localArtifactManifest(`http://127.0.0.1:${address.port}`, payloads),
          );
          return;
        }
        response.writeHead(404).end();
      })().catch(() => response.writeHead(500).end());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Test server address is unavailable");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const arguments_ = [
      "--backend-url",
      `http://127.0.0.1:${address.port}`,
      "--enrollment-file",
      enrollmentFile,
      "--platform",
      "darwin-arm64",
      "--output",
      output,
      "--allow-insecure-loopback",
      "true",
    ];
    try {
      await runInstallationPreparationCommand(arguments_);
      await runInstallationPreparationCommand(arguments_);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(exchangeBodies).toHaveLength(2);
    expect(exchangeBodies[0]).toEqual(exchangeBodies[1]);
    expect(Object.fromEntries(artifactRequests)).toEqual({
      release: 1,
      model: 1,
      fixture: 1,
    });
    const localManifest = JSON.parse(
      await readFile(join(output, "installation-artifacts.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(localManifest).toMatchObject({
      schemaVersion: 1,
      installationId,
      platform: "darwin-arm64",
      releaseVersion: "0.1.1",
      release: {
        releaseRoot: join(output, "installation-artifacts", "release-0.1.1"),
      },
    });
    await expect(
      stat(
        join(
          output,
          "installation-artifacts",
          "release-0.1.1",
          "release-manifest.json",
        ),
      ),
    ).resolves.toBeDefined();
    const verifiedReceipt = await readInstallationArtifactsReceipt(output);
    expect(verifiedReceipt).toMatchObject({
      installationId,
      platform: "darwin-arm64",
      releaseVersion: "0.1.1",
    });
    await writeFile(verifiedReceipt.model.path, "changed", { mode: 0o600 });
    await expect(readInstallationArtifactsReceipt(output)).rejects.toThrow(
      "Prepared installation artifact",
    );
    expect(JSON.stringify(localManifest)).not.toContain("signature");
    expect(JSON.stringify(localManifest)).not.toContain(installationCredential);
    expect(log.mock.calls.flat().join(" ")).not.toContain(
      installationCredential,
    );
  });

  it("rejects prebuilt reports outside explicit loopback testing", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-enrollment-"));
    roots.push(root);
    const output = join(root, "protected");
    await mkdir(output, { mode: 0o700 });
    await chmod(output, 0o700);
    const enrollmentFile = join(root, "enrollment.credential");
    await writeFile(enrollmentFile, `${enrollmentCredential}\n`, {
      mode: 0o600,
    });
    await chmod(enrollmentFile, 0o600);
    const reportFile = join(root, "report.json");
    await writeFile(reportFile, JSON.stringify(report()), { mode: 0o600 });

    await expect(
      runEnrollmentCommand([
        "--backend-url",
        "https://workers.example.test",
        "--enrollment-file",
        enrollmentFile,
        "--report",
        reportFile,
        "--output",
        output,
      ]),
    ).rejects.toThrow("Prebuilt reports are restricted to loopback testing");
  });
});

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: Array<{
    path: string;
    authorization: string | undefined;
    body: Record<string, unknown>;
  }>,
  isActivated: () => boolean,
  markActivated: () => void,
): Promise<void> {
  try {
    const body = fromWireCase(JSON.parse(await readBody(request))) as Record<
      string,
      unknown
    >;
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      body,
    });
    if (request.url === "/worker/installations") {
      send(response, {
        installationId,
        phase: isActivated() ? "activated" : "restricted",
        expiresAt: "2026-09-19T20:00:00.000Z",
        credential: installationCredential,
        replayed: isActivated(),
      });
      return;
    }
    if (request.url?.endsWith("/reports")) {
      send(response, {
        installationId,
        phase: "reported",
        outcomeCode: null,
        revision: 1,
        replayed: false,
      });
      return;
    }
    if (request.url?.endsWith("/activations")) {
      markActivated();
      send(response, {
        machineId,
        status: "active",
        credentialRevision: 1,
        replayed: isActivated(),
      });
      return;
    }
    response.writeHead(404).end();
  } catch {
    response.writeHead(500).end();
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(toWireCase(value)));
}

function json(
  value: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(toWireCase(value)), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function problem(
  code: string,
  status: number,
  headers?: Record<string, string>,
): Response {
  return json(
    {
      type: "about:blank",
      title: status === 429 ? "Too Many Requests" : "Service Unavailable",
      status,
      detail: "The request cannot be completed yet.",
      code,
      request_id: "request-1",
    },
    status,
    { "Content-Type": "application/problem+json; charset=utf-8", ...headers },
  );
}

function report() {
  return {
    label: "M4 worker",
    hardware: {
      os: "Darwin",
      osBuild: "25.6",
      architecture: "arm64",
      cpu: "Apple M4 Pro",
      memoryBytes: 24_000_000_000,
      gpus: [
        {
          id: "gpu0",
          name: "Apple M4 Pro",
          driverVersion: "system",
        },
      ],
    },
    runtime: {
      workerVersion: "0.1.0",
      protocolVersion: 1,
      manifestDigest: "a".repeat(64),
      modelDigest:
        "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
      providerRuntimeVersion: "onnxruntime 1.30.0",
    },
    capabilities: [
      {
        platform: "darwin-arm64",
        provider: "mps",
        gpuId: "gpu0",
        recipeIds: ["kim-vocals-v2"],
        maxSlots: 1,
      },
    ],
    summary: "qualified",
  };
}

function artifactManifest(platform: "darwin-arm64" | "windows-amd64") {
  const expiresAt = "2099-09-20T12:00:00.000Z";
  const common = {
    bytes: 7,
    sha256: "a".repeat(64),
    expiresAt,
  };
  return {
    schemaVersion: 1 as const,
    platform,
    release: {
      version: "0.1.1",
      filename:
        platform === "darwin-arm64"
          ? "musicmute-worker-darwin-arm64.tar.gz"
          : "musicmute-worker-windows-amd64.zip",
      ...common,
      contentType:
        platform === "darwin-arm64" ? "application/gzip" : "application/zip",
      url: "https://storage.example.invalid/release?signature=release",
    },
    model: {
      filename: "kim-vocal-2.onnx",
      bytes: common.bytes,
      sha256: common.sha256,
      contentType: "application/octet-stream",
      url: "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx",
      sourcePolicy: "direct-owner-source-only",
      allowedHosts: ["github.com", "release-assets.githubusercontent.com"],
      maxRedirects: 2,
    },
    fixture: {
      filename: "qualification.wav",
      ...common,
      contentType: "audio/wav",
      url: "https://storage.example.invalid/fixture?signature=fixture",
    },
  };
}

function localArtifactManifest(
  baseUrl: string,
  payloads: { release: Buffer; model: Buffer; fixture: Buffer },
) {
  const expiresAt = "2099-09-20T12:00:00.000Z";
  const artifact = (
    name: keyof typeof payloads,
    filename: string,
    contentType: string,
  ) => ({
    filename,
    bytes: payloads[name].length,
    sha256: createHash("sha256").update(payloads[name]).digest("hex"),
    contentType,
    url: `${baseUrl}/${name}?signature=temporary`,
    expiresAt,
  });
  const model = artifact(
    "model",
    "kim-vocal-2.onnx",
    "application/octet-stream",
  );
  return {
    schemaVersion: 1,
    platform: "darwin-arm64",
    release: {
      version: "0.1.1",
      ...artifact(
        "release",
        "musicmute-worker-darwin-arm64.tar.gz",
        "application/gzip",
      ),
    },
    model: {
      filename: model.filename,
      bytes: model.bytes,
      sha256: model.sha256,
      contentType: "application/octet-stream",
      url: model.url,
      sourcePolicy: "direct-owner-source-only",
      allowedHosts: [new URL(baseUrl).hostname],
      maxRedirects: 0,
    },
    fixture: artifact("fixture", "qualification.wav", "audio/wav"),
  };
}

async function createMacReleaseArchive(root: string): Promise<Buffer> {
  const release = join(root, "release-source");
  const archive = join(root, "release.tar.gz");
  const files: Array<[string, string, number]> = [
    ["app/dist/src/cli/main.js", "#!/usr/bin/env node\n", 0o755],
    ["app/engine/musicmute_engine/__init__.py", "VALUE = 1\n", 0o644],
    ["app/package.json", '{"private":true}\n', 0o644],
    ["runtime/node/bin/node", "#!/bin/sh\nexit 0\n", 0o755],
    ["runtime/python/bin/python3", "#!/bin/sh\nexit 0\n", 0o755],
    ["runtime/bin/ffmpeg", "#!/bin/sh\nexit 0\n", 0o755],
    ["runtime/bin/ffprobe", "#!/bin/sh\nexit 0\n", 0o755],
    ["runtime/media-source-manifest.json", '{"schemaVersion":1}\n', 0o644],
    ["runtime/licenses/ffmpeg/COPYING.LGPLv2.1", "ffmpeg\n", 0o644],
    ["runtime/licenses/lame/COPYING", "lame\n", 0o644],
  ];
  for (const [path, contents, mode] of files) {
    const absolute = join(release, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, { mode });
    await chmod(absolute, mode);
  }
  await writeMacReleaseManifest(release, "0.1.1");
  await execFile("tar", ["-czf", archive, "-C", release, "."]);
  return await readFile(archive);
}
