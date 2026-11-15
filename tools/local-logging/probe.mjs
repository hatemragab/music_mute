import { randomUUID } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { settings } from "./cli.mjs";
import { pathsFor } from "./collector.mjs";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function recentRows(file = pathsFor().events) {
  let handle;
  try {
    handle = await open(file, "r");
    const info = await handle.stat(),
      bytes = Math.min(info.size, 524288),
      buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, info.size - bytes);
    return buffer
      .toString()
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    // Rotation briefly removes the active path. The caller's existing deadline
    // and exact random trace match still apply; absence is never probe success.
    if (error.code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close();
  }
}
export async function probe({ idle = false } = {}) {
  if (idle) await wait(12000);
  const traceId = randomUUID(),
    config = await settings(),
    started = Date.now();
  const response = await fetch("http://127.0.0.1:19740/ingest/collector", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-musicmute-log-key": config.keys.collector,
    },
    body: JSON.stringify({
      name: "logging.probe",
      event: "logging.probe",
      timestamp: new Date().toISOString(),
      instanceId: "logging-probe-" + process.pid,
      traceId,
      level: "info",
      category: "health",
      summary: "Synthetic end-to-end capture probe",
      data: {
        nested: {
          safe: "expandable payload",
          password: "MUSICMUTE_PROBE_CREDENTIAL_CANARY",
        },
      },
    }),
  });
  if (response.status !== 202) throw Error("Probe ingress rejected");
  let record;
  while (Date.now() - started < 5000) {
    record = (await recentRows()).find((row) => row.traceId === traceId);
    if (record) break;
    await wait(20);
  }
  if (!record) throw Error("Probe not retained by Vector within five seconds");
  const result = {
    traceId,
    instanceId: record.instanceId,
    idle,
    observedLatencyMs: Date.now() - started,
    producerToVectorMs:
      Date.parse(record.collectedAt) - Date.parse(record.timestamp),
    payloadExpandable: record.data?.nested?.safe === "expandable payload",
    redacted: !JSON.stringify(record).includes(
      "MUSICMUTE_PROBE_CREDENTIAL_CANARY",
    ),
  };
  if (!result.redacted) throw Error("Probe redaction failed");
  await writeFile(
    pathsFor().directory + "/last-probe.json",
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  return result;
}
if (process.argv[1]?.endsWith("/probe.mjs"))
  console.log(
    JSON.stringify(
      await probe({ idle: process.argv.includes("--idle") }),
      null,
      2,
    ),
  );
