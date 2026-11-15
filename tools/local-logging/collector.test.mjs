import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  appendFile,
  readdir,
  rm,
  mkdir,
  rename,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCollector, pathsFor, captureSnapshot } from "./collector.mjs";
import { startIngress } from "./ingress.mjs";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, timeout = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return Date.now() - start;
    await pause(20);
  }
  throw Error("Capture did not receive the expected event");
}
async function rows(paths) {
  const deadline = Date.now() + 250;
  while (true) {
    let files = [paths.events];
    try {
      try {
        files.push(
          ...(await readdir(join(paths.directory, "archives")))
            .filter((n) => /^events\..*\.jsonl$/.test(n))
            .map((n) => join(paths.directory, "archives", n)),
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return (await Promise.all(files.map((f) => readFile(f, "utf8"))))
        .join("\n")
        .split("\n")
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        });
    } catch (error) {
      // The owner renames then recreates the active capture during rotation.
      // Re-enumerate the inventory; do not mistake this gap for data loss or
      // suppress other I/O failures. This time is included in latency checks.
      if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
      await pause(5);
    }
  }
}
test("capture integration reader retries only a bounded owner rotation gap", async (t) => {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "capture-reader-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = pathsFor(directory);
  const archives = join(paths.directory, "archives");
  await mkdir(archives, { recursive: true, mode: 0o700 });
  await writeFile(paths.events, '{"name":"retained-before-rotation"}\n');
  await rename(paths.events, join(archives, "events.fixture.jsonl"));
  const replacement = (async () => {
    await pause(20);
    await writeFile(paths.events, "", { mode: 0o600 });
  })();
  try {
    assert.deepEqual(await rows(paths), [{ name: "retained-before-rotation" }]);
  } finally {
    await replacement;
  }
  await unlink(paths.events);
  await assert.rejects(rows(paths), { code: "ENOENT" });
});
test(
  "real Vector: idle latency, load, rotation, native source redaction and checkpoint restart recovery",
  { timeout: 45000 },
  async (t) => {
    const directory = await mkdtemp(
      join(await realpath(tmpdir()), "musicmute-vector-"),
    );
    const native = join(directory, "mongo.log");
    await writeFile(
      native,
      JSON.stringify({ s: "I", id: 1, msg: "startup fixture" }) + "\n",
    );
    const key = "b".repeat(64),
      paths = pathsFor(directory);
    let collector;
    t.after(async () => {
      await collector?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const options = {
      directory,
      keys: { collector: key },
      port: 19890,
      nativeFiles: { mongodb: native },
      retention: {
        maxBytes: 12000,
        maxArchives: 4,
        maxAgeMs: 86400000,
        rotateAfterMs: 86400000,
      },
      interval: 250,
    };
    collector = await startCollector(options);
    const send = async (name) => {
      const res = await fetch("http://127.0.0.1:19890/ingest/collector", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-musicmute-log-key": key,
        },
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          name,
          instanceId: "integration",
          level: "info",
          data: {
            password: "SYNTHETIC_PASSWORD_MUST_NOT_PERSIST",
            nested: { safe: "expandable" },
          },
        }),
      });
      assert.equal(res.status, 202);
    };
    await appendFile(
      native,
      JSON.stringify({ s: "I", id: 2, msg: "warmup fixture" }) + "\n",
    );
    await eventually(async () =>
      (await rows(paths)).some((r) => r.source === "mongodb"),
    );
    await send("first");
    await eventually(async () =>
      (await rows(paths)).some((r) => r.name === "first"),
    );
    await pause(12000);
    const started = Date.now();
    await send("after-idle");
    await eventually(async () =>
      (await rows(paths)).some((r) => r.name === "after-idle"),
    );
    assert.ok(
      Date.now() - started < 2000,
      `idle latency ${Date.now() - started}ms`,
    );
    for (let batch = 0; batch < 30; batch += 6)
      await Promise.all(
        Array.from({ length: 6 }, (_, i) => send("traffic-" + (batch + i))),
      );
    await eventually(
      async () =>
        (await rows(paths)).filter((r) => r.name.startsWith("traffic-"))
          .length === 30,
    );
    await appendFile(
      native,
      JSON.stringify({
        t: { $date: new Date().toISOString() },
        s: "W",
        c: "NETWORK",
        id: 23015,
        msg: "password=SYNTHETIC_NATIVE_SECRET",
        attr: { authorization: "SYNTHETIC_NATIVE_SECRET" },
      }) + "\n",
    );
    await eventually(
      async () =>
        (await rows(paths)).filter((r) => r.source === "mongodb").length >= 2,
    );
    await collector.maintain();
    assert.equal(
      await Promise.race([
        collector.done.then(() => true),
        pause(100).then(() => false),
      ]),
      false,
      "rotation must preserve collector lifetime",
    );
    assert.ok(
      (await readdir(join(paths.directory, "archives"))).some((n) =>
        n.startsWith("events."),
      ),
    );
    await collector.close();
    collector = null;
    const before = await rows(paths);
    collector = await startCollector(options);
    await send("after-restart");
    await eventually(async () =>
      (await rows(paths)).some((r) => r.name === "after-restart"),
    );
    const all = await rows(paths);
    assert.equal(all.filter((r) => r.name === "first").length, 1);
    assert.ok(all.length >= before.length + 1);
    assert.doesNotMatch(JSON.stringify(all), /SYNTHETIC_(?:PASSWORD|NATIVE)/);
    assert.ok((await captureSnapshot(paths)).bytes > 0);
  },
);
test("ingress refuses hostile Host even from a direct native HTTP client", async (t) => {
  const port = 19891,
    ingress = await startIngress({
      port,
      keys: { backend: "k" },
      writer: { async write() {}, async close() {} },
    });
  t.after(() => ingress.close());
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/health",
        headers: { Host: "evil.test" },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

test(
  "maintenance health exposes closed failure metadata and clears only after a successful safe cycle",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(
      join(await realpath(tmpdir()), "collector-health-"),
    );
    let collector;
    t.after(async () => {
      await collector?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const paths = pathsFor(directory);
    collector = await startCollector({
      directory,
      keys: { collector: "health-fixture" },
      port: 19893,
      nativeFiles: {},
      journalFiles: {},
      interval: 60000,
    });
    // Let Vector's initial empty checkpoint write settle. With no producers its
    // checkpoint state is then unchanged throughout this controlled fixture.
    await pause(1100);
    const checkpoint = join(paths.state, "application/checkpoints.json");
    const saved = checkpoint + ".SYNTHETIC_PRIVATE_PATH";
    await mkdir(join(paths.state, "application"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(checkpoint, '{"version":"1","checkpoints":[]}', {
      mode: 0o600,
    });
    await rename(checkpoint, saved);
    await symlink(saved, checkpoint);
    await collector.maintain();
    const failed = await (await fetch("http://127.0.0.1:19893/health")).json();
    assert.equal(failed.maintenanceFailure, true);
    assert.equal(failed.maintenance.lastFailurePhase, "input_prune");
    assert.equal(failed.maintenance.lastFailureCode, "UNSAFE_INPUT_LOG_FILES");
    assert.equal(failed.maintenance.consecutiveFailures, 1);
    assert.doesNotMatch(
      JSON.stringify(failed),
      /SYNTHETIC_PRIVATE_PATH|could not safely/,
    );
    await unlink(checkpoint);
    await rename(saved, checkpoint);
    await collector.maintain();
    const recovered = await (
      await fetch("http://127.0.0.1:19893/health")
    ).json();
    assert.equal(recovered.maintenanceFailure, false);
    assert.equal(recovered.maintenance.consecutiveFailures, 0);
    assert.equal(recovered.maintenance.failures, failed.maintenance.failures);
    assert.equal(
      recovered.maintenance.lastFailureCode,
      "UNSAFE_INPUT_LOG_FILES",
    );
    assert.ok(
      Date.parse(recovered.maintenance.lastSuccessAt) >=
        Date.parse(failed.maintenance.lastFailureAt),
    );
    assert.equal(recovered.capture.inputRetention.checkpointAvailable, true);
  },
);

test(
  "real Vector native churn cannot erase confirmed ingress freshness from the bounded capture tail",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(
      join(await realpath(tmpdir()), "collector-freshness-"),
    );
    let collector;
    t.after(async () => {
      await collector?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const native = join(directory, "mongo.log");
    await writeFile(native, '{"s":"I","id":1}\n', { mode: 0o600 });
    const paths = pathsFor(directory);
    collector = await startCollector({
      directory,
      keys: { collector: "freshness-fixture" },
      port: 19896,
      nativeFiles: { mongodb: native },
      interval: 60000,
    });
    const send = async (name) => {
      const response = await fetch("http://127.0.0.1:19896/ingest/collector", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-musicmute-log-key": "freshness-fixture",
        },
        body: JSON.stringify({ name, instanceId: "freshness", level: "info" }),
      });
      assert.equal(response.status, 202);
    };
    const health = async () =>
      (await fetch("http://127.0.0.1:19896/health")).json();
    await send("confirmed-before-churn");
    await eventually(async () =>
      (await rows(paths)).some((row) => row.name === "confirmed-before-churn"),
    );
    await collector.maintain();
    const before = await captureSnapshot(paths);
    assert.equal(before.latestIngressByCapture[collector.captureId], 1);
    await appendFile(
      native,
      Array.from({ length: 1200 }, (_, id) =>
        JSON.stringify({ s: "I", c: "NETWORK", id: 10000 + id }),
      ).join("\n") + "\n",
    );
    await eventually(
      async () =>
        (await rows(paths)).filter((row) => row.source === "mongodb").length ===
        1200,
      5000,
    );
    const after = await captureSnapshot(paths);
    assert.ok(after.bytes - before.bytes > 262144);
    assert.equal(after.latestIngressByCapture[collector.captureId], undefined);
    // Exercise the actual freshness deadline, rather than only inspecting the
    // counter while its short grace period would still hide the regression.
    await pause(5100);
    await collector.maintain();
    const idle = await health();
    assert.equal(idle.freshness.outstanding, 0);
    assert.equal(idle.freshness.healthy, true);
    assert.equal(idle.maintenanceFailure, false);
    await send("new-sequence-after-churn");
    const pending = await health();
    assert.equal(pending.freshness.outstanding, 1);
    assert.equal(pending.freshness.healthy, true);
    await eventually(async () =>
      (await rows(paths)).some(
        (row) => row.name === "new-sequence-after-churn",
      ),
    );
    await collector.maintain();
    assert.equal((await health()).freshness.outstanding, 0);
  },
);
