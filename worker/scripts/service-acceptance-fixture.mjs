import { createHash } from "node:crypto";
import {
  appendFileSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

const [configPath, credentialPath, inputPath, outputPath] =
  process.argv.slice(2);
if (!configPath || !credentialPath || !inputPath || !outputPath)
  throw new Error(
    "usage: service-acceptance-fixture <config> <credential> <input> <output>",
  );

const config = JSON.parse(readFileSync(configPath, "utf8"));
const credential = readFileSync(credentialPath, "utf8").trim();
const input = readFileSync(inputPath);
const inputSha256 = createHash("sha256").update(input).digest("base64");
const logPath = join(dirname(outputPath), "service-acceptance-requests.log");
const attemptId = "99f8016b-67f3-4f4b-beb4-205a7b87147e";
const jobId = "64b000000000000000000001";
let claimed = false;
let completed = false;

const recipe = {
  recipeId: "kim-vocals-v2",
  recipeRevision: 3,
  protocolVersion: 1,
  recipeDigest:
    "a1b3be857b9604429edf9b9cc48df6a84be2bcf4a2bb9a2da2c4e829f1d6ef52",
  modelFilename: "Kim_Vocal_2.onnx",
  modelDigest:
    "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
  modelBytes: 66_759_214,
  preparationProfileId: "pcm16-stereo-44100-v1",
  stepIds: [
    "prepare-pcm16-stereo-44100-v1",
    "separate-kim-vocal-2-v1",
    "encode-mp3-up-to-160k-v1",
    "validate-audio-v1",
  ],
  trimEnabled: false,
  denoiseEnabled: false,
  denoisePresetId: null,
  trimProfileId: null,
  outputFormat: "mp3",
  outputBitrateKbps: 160,
};

function send(response, status, value) {
  const problem = status >= 400;
  response.writeHead(status, {
    "Content-Type": problem ? "application/problem+json" : "application/json",
  });
  response.end(
    JSON.stringify(
      problem
        ? {
            type: "about:blank",
            title: "Request failed",
            status,
            detail: "The fixture request could not be completed.",
            code: value.code,
            request_id: "acceptance-fixture",
          }
        : convertKeys(value, (key) =>
            key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
          ),
    ),
  );
}

function convertKeys(value, keyCase, parentKey) {
  if (Array.isArray(value))
    return value.map((item) => convertKeys(item, keyCase, parentKey));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      keyCase(key),
      key === "headers" || (parentKey === "signed" && key === "metadata")
        ? item
        : convertKeys(item, keyCase, key),
    ]),
  );
}

async function readBody(request, limit = 64 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("request is too large");
    chunks.push(chunk);
  }
  return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, bytes);
}

function record(method, path) {
  appendFileSync(logPath, `${new Date().toISOString()} ${method} ${path}\n`, {
    mode: 0o600,
  });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1:3100");
    const method = request.method ?? "GET";
    if (url.pathname.startsWith("/worker/")) {
      if (request.headers.authorization !== `Bearer ${credential}`)
        return send(response, 401, { code: "WORKER_UNAUTHENTICATED" });
    }
    const rawBody =
      method === "POST" || method === "PUT"
        ? await readBody(request, method === "PUT" ? 30_000_000 : undefined)
        : Buffer.alloc(0);
    const body =
      method === "POST" && rawBody.length > 0
        ? convertKeys(JSON.parse(rawBody.toString("utf8")), (key) =>
            key.replace(/_([a-z0-9])/g, (_match, letter) =>
              letter.toUpperCase(),
            ),
          )
        : {};
    const now = new Date().toISOString();
    record(method, url.pathname);

    if (url.pathname.endsWith("/worker/sessions"))
      return send(response, 200, {
        machineId: config.machineId,
        policyRevision: 1,
        serverTime: now,
      });
    if (url.pathname.endsWith("/worker/config"))
      return send(response, 200, {
        machineId: config.machineId,
        machineStatus: "active",
        desiredRevision: 1,
        appliedRevision: 1,
        claimAllowed: !completed,
        policy: {
          revision: 1,
          acceptClaims: !completed,
          recipes: [
            {
              recipeId: recipe.recipeId,
              enabled: true,
              maxSlotsPerMachine: 1,
            },
          ],
          leaseSeconds: 90,
          processingDeadlineSeconds: 1_800,
          maxAttempts: 3,
        },
        compatibleRelease: null,
        commands: [],
        serverTime: now,
      });
    if (url.pathname.endsWith("/worker/slots"))
      return send(response, 200, {
        workerId: body.workerId,
        state: "idle",
        revision: 0,
        serverTime: now,
      });
    if (url.pathname.endsWith("/worker/claims")) {
      if (claimed) return send(response, 200, { claim: null, serverTime: now });
      claimed = true;
      return send(response, 200, {
        claim: {
          attemptId,
          jobId,
          attemptNumber: 1,
          leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
          deadlineAt: new Date(Date.now() + 1_800_000).toISOString(),
          input: {
            key: "acceptance/input.wav",
            versionId: "acceptance-input-v1",
            bytes: input.length,
            sha256: inputSha256,
            contentType: "audio/wav",
          },
          recipe,
          replayed: false,
        },
        serverTime: now,
      });
    }
    if (url.pathname.endsWith("/worker/leases/renewals"))
      return send(response, 200, {
        requestId: body.requestId,
        serverTime: now,
        results: (body.leases ?? []).map((lease) => ({
          jobId: lease.jobId,
          attemptId: lease.attemptId,
          disposition: "accepted",
          leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
        })),
      });
    if (url.pathname.endsWith(`/${attemptId}/input-grants`))
      return send(response, 200, {
        requestId: body.requestId,
        attemptId,
        object: {
          key: "acceptance/input.wav",
          versionId: "acceptance-input-v1",
          bytes: input.length,
          sha256: inputSha256,
          contentType: "audio/wav",
        },
        grant: {
          url: "http://127.0.0.1:3100/acceptance/input",
          expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
        },
      });
    if (url.pathname === "/acceptance/input") {
      response.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": input.length,
      });
      return response.end(input);
    }
    if (url.pathname.endsWith(`/${attemptId}/output-grants`))
      return send(response, 200, {
        requestId: body.requestId,
        attemptId,
        reservation: {
          key: `acceptance/${attemptId}/vocals.mp3`,
          bytes: body.bytes,
          sha256: body.sha256,
          contentType: "audio/mpeg",
          measuredDurationSeconds: body.measuredDurationSeconds,
        },
        grant: {
          method: "PUT",
          url: "http://127.0.0.1:3100/acceptance/output",
          headers: {
            "Content-Type": "audio/mpeg",
            "x-amz-checksum-sha256": body.sha256,
            "If-None-Match": "*",
          },
          expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
        },
        object: null,
      });
    if (url.pathname === "/acceptance/output") {
      if (request.headers["if-none-match"] !== "*")
        throw new Error("output precondition is missing");
      const expected = request.headers["x-amz-checksum-sha256"];
      const actual = createHash("sha256").update(rawBody).digest("base64");
      if (typeof expected !== "string" || actual !== expected)
        throw new Error("output digest does not match");
      const temporary = `${outputPath}.uploading`;
      writeFileSync(temporary, rawBody, { mode: 0o600 });
      renameSync(temporary, outputPath);
      response.writeHead(200, { "x-amz-version-id": "acceptance-output-v1" });
      return response.end();
    }
    if (url.pathname.endsWith(`/${attemptId}/completions`)) {
      completed = true;
      console.log("COMPLETE");
      return send(response, 200, {
        attemptId,
        jobId,
        status: "ready",
        replayed: false,
      });
    }
    if (url.pathname.endsWith(`/${attemptId}/failures`)) {
      console.log(`FAILED ${String(body.code ?? "unknown")}`);
      return send(response, 200, { attemptId, jobId, status: "failed" });
    }
    return send(response, 404, { code: "WORKER_NOT_FOUND" });
  } catch {
    return send(response, 400, { code: "WORKER_INVALID_REQUEST" });
  }
});

server.listen(3100, "127.0.0.1", () => console.log("READY"));
process.once("SIGINT", () => server.close());
process.once("SIGTERM", () => server.close());
