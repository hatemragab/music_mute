import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/redact.js";
import { parseArguments } from "../src/index.js";
import {
  searchLogsInputSchema,
  traceRequestInputSchema,
} from "../src/schemas.js";
test("MCP defense-in-depth redacts alias keys, encoded JSON and websocket credentials", () => {
  const marker = "SYNTHETIC_MCP_CREDENTIAL_CANARY";
  for (const value of [
    { access_key_id: marker },
    { session_id: marker },
    { url: "wss://user:" + marker + "@example.test/?auth=" + marker },
    { ["password=" + marker]: "value" },
    Buffer.from(JSON.stringify({ password: marker })).toString("base64"),
  ])
    assert.doesNotMatch(JSON.stringify(redact(value)), new RegExp(marker));
});
test("all MusicMute sources and exact operation/resource filters are supported", () => {
  for (const source of [
    "backend",
    "web-client",
    "dashboard",
    "landing-page",
    "chrome-extension",
    "macos",
    "worker",
    "windows-desktop",
    "ios",
    "android",
    "provider",
    "mongodb",
    "redis",
    "collector",
  ])
    assert.equal(
      searchLogsInputSchema.parse({
        source,
        operation: "find",
        service: "router",
        result: "failed",
        jobId: "job",
        level: "debug",
      }).source,
      source,
    );
  assert.equal(
    traceRequestInputSchema.parse({
      requestId: "request",
      source: "backend",
      instanceId: "api",
    }).instanceId,
    "api",
  );
});
test("stdio accepts no caller-supplied filesystem paths", () => {
  assert.throws(() => parseArguments(["--file", "/tmp/arbitrary"]));
  assert.throws(() => parseArguments(["../capture.jsonl"]));
});
