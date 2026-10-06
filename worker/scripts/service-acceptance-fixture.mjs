import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const recipeIds = ["kim-vocals-v2", "kim-vocals-v2-trim"];
const wire = (value) =>
  convertKeys(value, (key) =>
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
  );
const internal = (value) =>
  convertKeys(value, (key) =>
    key.replace(/_([a-z0-9])/g, (_match, letter) => letter.toUpperCase()),
  );

/** Loopback-only synthetic control plane/storage. Never enrolls with a real backend. */
export function createAcceptanceFixture({
  config,
  credential,
  input,
  recipes,
  outputPath,
  claimsEnabled = () => existsSync(`${outputPath}.claims-enabled`),
  corruptInputSlot = null,
  cancelOnSeparationSlot = null,
  jobsPerSlot = 1,
}) {
  if (
    !UUID.test(config.machineId) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(credential) ||
    !Buffer.isBuffer(input) ||
    input.length < 1 ||
    input.length > 512 * 1024 * 1024 ||
    recipes.length !== 2 ||
    recipes.some((recipe, index) => recipe.recipeId !== recipeIds[index]) ||
    ![null, 0, 1].includes(corruptInputSlot) ||
    ![null, 0, 1].includes(cancelOnSeparationSlot) ||
    !Number.isSafeInteger(jobsPerSlot) ||
    jobsPerSlot < 1 ||
    jobsPerSlot > 4
  )
    throw new Error("Acceptance fixture configuration is invalid");
  for (const suffix of [
    ".evidence.json",
    ".evidence.tmp",
    ...Array.from({ length: jobsPerSlot * 2 }, (_, index) => `.${index}.mp3`),
    ".claims-enabled",
  ]) {
    if (existsSync(`${outputPath}${suffix}`))
      throw new Error("Acceptance fixture requires a new output prefix");
  }
  const started = performance.now();
  const slots = new Map();
  const claims = new Map();
  const sessions = new Set();
  let diagnosticCursor = 0;
  let maxActiveAttempts = 0;
  const requests = {};
  const jobs = Array.from({ length: jobsPerSlot * 2 }, (_, index) => ({
    attemptId: randomUUID(),
    jobId: `64b00000000000000000000${index + 1}`,
    recipe: recipes[index % 2],
    slotIndex: index % 2,
    workerId: null,
    status: "waiting",
    claim: null,
    reservation: null,
    upload: null,
    completion: null,
    failureCode: null,
    claimedAtMs: null,
    separationObservedAtMs: null,
    outputReceivedAtMs: null,
    completedAtMs: null,
    cancellationIssuedAtMs: null,
    progressSequence: -1,
    grant: randomUUID(),
  }));
  const inputObject = {
    key: "acceptance/input.wav",
    etag: '"acceptance-input-v1"',
    bytes: input.length,
    sha256: createHash("sha256").update(input).digest("base64"),
    contentType: "audio/wav",
  };
  const milliseconds = () => performance.now() - started;
  const active = () => jobs.filter((job) => job.status === "running").length;
  const snapshot = () => ({
    schemaVersion: 1,
    scope: "loopback-synthetic-backend-and-storage",
    maxActiveAttempts,
    registeredSlots: [...slots.values()],
    diagnosticCursor,
    requests,
    jobs: jobs.map(
      ({ grant: _grant, claim: _claim, reservation: _reservation, ...job }) =>
        job,
    ),
  });
  const persist = () => {
    const temporary = `${outputPath}.evidence.tmp`;
    writeFileSync(temporary, `${JSON.stringify(snapshot(), null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, `${outputPath}.evidence.json`);
  };
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  const expiresAt = () => new Date(Date.now() + 7_200_000).toISOString();
  const sessionKey = (body) => `${body.sessionId}:${body.incarnation}`;
  const owns = (job, body) =>
    job?.workerId === body.workerId && sessions.has(sessionKey(body));
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin());
      const path = url.pathname;
      const method = request.method ?? "GET";
      requests[`${method} ${path.replace(/[a-f0-9-]{36}/gu, ":id")}`] =
        (requests[`${method} ${path.replace(/[a-f0-9-]{36}/gu, ":id")}`] ?? 0) +
        1;
      if (
        path.startsWith("/worker/") &&
        request.headers.authorization !== `Bearer ${credential}`
      )
        return send(response, 401, { code: "WORKER_UNAUTHENTICATED" });
      const raw =
        method === "POST" || method === "PUT"
          ? await readBody(request, method === "PUT" ? 30_000_000 : 128 * 1024)
          : Buffer.alloc(0);
      const body =
        method === "POST" && raw.length
          ? internal(JSON.parse(raw.toString("utf8")))
          : {};
      const now = new Date().toISOString();
      if (method === "POST" && path === "/worker/sessions") {
        if (!UUID.test(body.sessionId) || !UUID.test(body.incarnation))
          throw new Error("Invalid session");
        sessions.add(sessionKey(body));
        return send(response, 200, {
          machineId: config.machineId,
          policyRevision: 1,
          serverTime: now,
        });
      }
      if (method === "GET" && path === "/worker/config") {
        const enabled =
          claimsEnabled() && jobs.some((job) => job.status === "waiting");
        return send(response, 200, {
          machineId: config.machineId,
          machineStatus: "active",
          desiredRevision: 1,
          appliedRevision: 1,
          claimAllowed: enabled,
          policy: {
            revision: 1,
            acceptClaims: true,
            recipes: recipeIds.map((recipeId) => ({
              recipeId,
              enabled: true,
              maxSlotsPerMachine: 2,
            })),
            leaseSeconds: 90,
            processingDeadlineSeconds: 7200,
          },
          commands: [],
          serverTime: now,
        });
      }
      if (method === "POST" && path === "/worker/config/applications")
        return send(response, 200, { requestId: body.requestId, revision: 1 });
      if (method === "GET" && path === "/worker/status")
        return send(response, 200, {
          machineId: config.machineId,
          status: "active",
          groupId: null,
          policyRevision: 1,
          revision: 1,
          lastSeenAt: now,
          activeAttempts: active(),
          claimsAllowed: claimsEnabled(),
        });
      if (method === "POST" && path === "/worker/slots") {
        if (
          !sessions.has(sessionKey(body)) ||
          !UUID.test(body.workerId) ||
          body.gpuId !== "gpu0" ||
          ![0, 1].includes(body.slotIndex)
        )
          return send(response, 409, { code: "WORKER_CONFLICT" });
        slots.set(body.slotIndex, {
          workerId: body.workerId,
          slotIndex: body.slotIndex,
          sessionId: body.sessionId,
          incarnation: body.incarnation,
        });
        persist();
        return send(response, 200, {
          workerId: body.workerId,
          state: "idle",
          revision: 0,
          serverTime: now,
        });
      }
      if (method === "POST" && path === "/worker/claims") {
        const slot = slots.get(body.slotIndex);
        if (
          !slot ||
          slot.workerId !== body.workerId ||
          slot.sessionId !== body.sessionId ||
          slot.incarnation !== body.incarnation ||
          !UUID.test(body.requestId)
        )
          return send(response, 409, { code: "WORKER_CONFLICT" });
        if (claims.has(body.requestId)) {
          const previous = claims.get(body.requestId);
          if (previous.workerId !== body.workerId)
            return send(response, 409, { code: "WORKER_CONFLICT" });
          return send(response, 200, {
            claim: previous.claim && { ...previous.claim, replayed: true },
            serverTime: now,
          });
        }
        const job = jobs.find(
          (candidate) =>
            candidate.slotIndex === body.slotIndex &&
            candidate.status === "waiting",
        );
        if (
          !claimsEnabled() ||
          !job ||
          jobs.some(
            (candidate) =>
              candidate.slotIndex === body.slotIndex &&
              candidate.status === "running",
          )
        ) {
          claims.set(body.requestId, { workerId: body.workerId, claim: null });
          return send(response, 200, { claim: null, serverTime: now });
        }
        job.status = "running";
        job.workerId = body.workerId;
        job.claimedAtMs = milliseconds();
        job.claim = {
          attemptId: job.attemptId,
          jobId: job.jobId,
          attemptNumber: 1,
          leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
          deadlineAt: expiresAt(),
          input: inputObject,
          recipe: job.recipe,
          replayed: false,
        };
        claims.set(body.requestId, {
          workerId: body.workerId,
          claim: job.claim,
        });
        maxActiveAttempts = Math.max(maxActiveAttempts, active());
        persist();
        return send(response, 200, { claim: job.claim, serverTime: now });
      }
      if (method === "POST" && path === "/worker/leases/renewals") {
        const results = (body.leases ?? []).map((lease) => {
          const job = jobs.find(
            (candidate) => candidate.attemptId === lease.attemptId,
          );
          const identity = { ...body, workerId: lease.workerId };
          let disposition = "revoked";
          if (job?.jobId === lease.jobId && owns(job, identity)) {
            if (
              job.status === "running" &&
              job.slotIndex === cancelOnSeparationSlot &&
              job.separationObservedAtMs !== null
            ) {
              job.status = "cancelled";
              job.cancellationIssuedAtMs = milliseconds();
            }
            disposition =
              job.status === "running"
                ? "accepted"
                : job.status === "cancelled"
                  ? "cancelled"
                  : "expired";
          }
          return {
            jobId: lease.jobId,
            attemptId: lease.attemptId,
            disposition,
            leaseExpiresAt:
              disposition === "accepted"
                ? new Date(Date.now() + 90_000).toISOString()
                : null,
          };
        });
        persist();
        return send(response, 200, {
          requestId: body.requestId,
          serverTime: now,
          results,
        });
      }
      if (method === "GET" && path === "/worker/logs/cursor")
        return send(response, 200, { acknowledgedSequence: diagnosticCursor });
      if (method === "POST" && path === "/worker/logs") {
        if (
          !Number.isSafeInteger(body.sequenceEnd) ||
          body.sequenceEnd < diagnosticCursor
        )
          throw new Error("Invalid diagnostic sequence");
        const replayed = body.sequenceEnd === diagnosticCursor;
        diagnosticCursor = body.sequenceEnd;
        return send(response, 200, {
          acknowledgedSequence: diagnosticCursor,
          replayed,
        });
      }
      const match =
        /^\/worker\/attempts\/([a-f0-9-]{36})\/(input-grants|output-grants|progress-events|completions|failures)$/u.exec(
          path,
        );
      if (method === "POST" && match) {
        const job = jobs.find((candidate) => candidate.attemptId === match[1]);
        if (!job || !owns(job, body))
          return send(response, 409, { code: "WORKER_CONFLICT" });
        if (job.status === "cancelled")
          return send(response, 409, { code: "WORKER_OWNERSHIP_LOST" });
        const common = { requestId: body.requestId, attemptId: job.attemptId };
        if (match[2] === "input-grants")
          return send(response, 200, {
            ...common,
            object: inputObject,
            grant: {
              url: `${origin()}/acceptance/${job.attemptId}/input?grant=${job.grant}`,
              expiresAt: expiresAt(),
            },
          });
        if (match[2] === "progress-events") {
          job.progressSequence = Math.max(job.progressSequence, body.sequence);
          if (
            body.phase === "separating" &&
            job.separationObservedAtMs === null
          )
            job.separationObservedAtMs = milliseconds();
          persist();
          return send(response, 200, {
            ...common,
            accepted: true,
            sequence: job.progressSequence,
          });
        }
        if (match[2] === "output-grants") {
          const reservation = {
            key: `acceptance/${job.attemptId}/vocals.mp3`,
            bytes: body.bytes,
            sha256: body.sha256,
            contentType: "audio/mpeg",
            measuredDurationSeconds: body.measuredDurationSeconds,
          };
          if (
            !Number.isSafeInteger(body.bytes) ||
            body.bytes < 1 ||
            body.bytes > 30_000_000 ||
            !/^[A-Za-z0-9+/]{43}=$/u.test(body.sha256)
          )
            throw new Error("Invalid output");
          if (
            job.reservation &&
            JSON.stringify(job.reservation) !== JSON.stringify(reservation)
          )
            return send(response, 409, { code: "WORKER_CONFLICT" });
          job.reservation = reservation;
          return send(response, 200, {
            ...common,
            reservation,
            grant: {
              method: "PUT",
              url: `${origin()}/acceptance/${job.attemptId}/output?grant=${job.grant}`,
              headers: {
                "Content-Type": "audio/mpeg",
                "x-amz-checksum-sha256": body.sha256,
                "x-amz-meta-sha256": body.sha256,
                "If-None-Match": "*",
              },
              expiresAt: expiresAt(),
            },
            object: null,
          });
        }
        if (match[2] === "completions") {
          if (
            !job.upload ||
            body.etag !== job.upload.etag ||
            body.recipeDigest !== job.recipe.recipeDigest ||
            body.modelDigest !== job.recipe.modelDigest
          )
            return send(response, 409, { code: "WORKER_CONFLICT" });
          const replayed = job.status === "ready";
          job.status = "ready";
          job.completedAtMs ??= milliseconds();
          job.completion = {
            stageTimings: body.stageTimings,
            executionTimings: body.executionTimings,
            recipeId: body.recipeId,
          };
          persist();
          return send(response, 200, {
            ...common,
            jobId: job.jobId,
            status: "ready",
            replayed,
          });
        }
        job.status = "failed";
        job.failureCode = String(body.code);
        job.completedAtMs = milliseconds();
        persist();
        return send(response, 200, {
          ...common,
          jobId: job.jobId,
          status: "failed",
        });
      }
      const transfer = /^\/acceptance\/([a-f0-9-]{36})\/(input|output)$/u.exec(
        path,
      );
      if (transfer) {
        const job = jobs.find(
          (candidate) => candidate.attemptId === transfer[1],
        );
        if (
          !job ||
          job.status !== "running" ||
          url.searchParams.get("grant") !== job.grant
        )
          return send(response, 403, { code: "WORKER_FORBIDDEN" });
        if (method === "GET" && transfer[2] === "input") {
          const bytes = Buffer.from(input);
          if (job.slotIndex === corruptInputSlot) bytes[0] ^= 1;
          response.writeHead(200, {
            "Content-Type": "audio/wav",
            "Content-Length": bytes.length,
          });
          return response.end(bytes);
        }
        if (method === "PUT" && transfer[2] === "output") {
          if (job.upload)
            return send(response, 412, { code: "WORKER_CONFLICT" });
          const actual = createHash("sha256").update(raw).digest("base64");
          if (
            !job.reservation ||
            request.headers["if-none-match"] !== "*" ||
            raw.length !== job.reservation.bytes ||
            actual !== job.reservation.sha256 ||
            request.headers["x-amz-checksum-sha256"] !== actual ||
            request.headers["x-amz-meta-sha256"] !== actual
          )
            return send(response, 400, { code: "WORKER_INVALID_REQUEST" });
          const outputIndex = jobs.indexOf(job);
          const path = `${outputPath}.${outputIndex}.mp3`;
          writeFileSync(path, raw, { flag: "wx", mode: 0o600 });
          job.upload = {
            bytes: raw.length,
            sha256: actual,
            etag: `"acceptance-output-${outputIndex}"`,
          };
          job.outputReceivedAtMs = milliseconds();
          persist();
          response.writeHead(200, { ETag: job.upload.etag });
          return response.end();
        }
      }
      return send(response, 404, { code: "WORKER_NOT_FOUND" });
    } catch {
      return send(response, 400, { code: "WORKER_INVALID_REQUEST" });
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  return { server, snapshot, persist };
}

function send(response, status, value) {
  response.writeHead(status, {
    "Content-Type":
      status >= 400 ? "application/problem+json" : "application/json",
    "Cache-Control": "no-store",
  });
  response.end(
    JSON.stringify(
      status >= 400
        ? {
            type: "about:blank",
            title: "Fixture request failed",
            status,
            detail: "The synthetic fixture request could not be completed.",
            code: value.code,
            request_id: "acceptance-fixture",
          }
        : wire(value),
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
async function readBody(request, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [
    configPath,
    credentialPath,
    inputPath,
    outputPath,
    scenario = "success",
    ...unexpected
  ] = process.argv.slice(2);
  if (
    !configPath ||
    !credentialPath ||
    !inputPath ||
    !outputPath ||
    unexpected.length ||
    !["success", "corrupt-input", "cancel-during-separation"].includes(scenario)
  )
    throw new Error(
      "usage: service-acceptance-fixture <synthetic-config> <synthetic-credential> <input.wav> <new-output-prefix> [success|corrupt-input|cancel-during-separation]",
    );
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const url = new URL(config.backendBaseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !config.allowInsecureLoopback
  )
    throw new Error(
      "Service acceptance requires an explicit loopback configuration",
    );
  const recipes = JSON.parse(
    execFileSync(
      config.pythonPath,
      [
        "-I",
        "-B",
        "-c",
        "import sys,json; sys.path.insert(0,sys.argv[1]); from musicmute_engine.recipes import recipe_snapshot; print(json.dumps([recipe_snapshot('kim-vocals-v2',False),recipe_snapshot('kim-vocals-v2-trim',True)]))",
        config.engineRoot,
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 },
    ),
  );
  const fixture = createAcceptanceFixture({
    config,
    credential: readFileSync(credentialPath, "utf8").trim(),
    input: readFileSync(inputPath),
    recipes,
    outputPath,
    corruptInputSlot: scenario === "corrupt-input" ? 0 : null,
    cancelOnSeparationSlot: scenario === "cancel-during-separation" ? 0 : null,
  });
  fixture.server.listen(Number(url.port) || 80, "127.0.0.1", () => {
    fixture.persist();
    console.log("READY");
  });
  const stop = () => {
    fixture.persist();
    fixture.server.close();
    fixture.server.closeAllConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
