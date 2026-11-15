import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ErrorSummaryResult,
  SearchLogsResult,
  TraceRequestResult,
  TraceEventsResult,
} from "../src/types.js";

const entrypoint = fileURLToPath(new URL("../src/index.js", import.meta.url));
const timestamp = "2026-10-16T12:00:00.000Z";
const base = {
  timestamp,
  level: "info",
  source: "backend",
  requestId: "trace-1",
  userId: "actor-1",
};
const fixtures = [
  {
    ...base,
    event: "http_request",
    method: "POST",
    route: "/messages",
    status: 200,
    durationMs: 3,
    requestBody: { text: "MCP synthetic fixture", password: "[REDACTED]" },
  },
  {
    ...base,
    event: "realtime_publication",
    actorUserId: "actor-1",
    recipientUserId: "recipient-1",
    publicationId: "publication-1",
    eventType: "message_new",
    attempt: 1,
    level: "warn",
    result: "failure",
    status: 503,
  },
  {
    ...base,
    event: "realtime_publication",
    actorUserId: "actor-1",
    recipientUserId: "recipient-1",
    publicationId: "publication-1",
    eventType: "message_new",
    attempt: 2,
    result: "success",
    status: 200,
  },
  {
    ...base,
    requestId: "failure-1",
    event: "http_request",
    method: "GET",
    route: "/users",
    status: 500,
    level: "error",
  },
];

const serviceFixtures = [
  "web-client",
  "redis",
  "mongodb",
  "macos",
  "collector",
].map((source) => ({
  ...base,
  source,
  requestId: null,
  userId: null,
  event: "inspector",
  instanceId: `${source}-a`,
  captureId: "capture-a",
  traceId: "t19",
  category: "realtime",
  name: "inbox.publication",
  phase: "end",
  seq: 1,
  spanId: "s21",
  parentSpanId: "s20",
  sessionGeneration: 3,
  roomId: "room-a",
  durationMicros: 265300,
  data: { operationCount: 1, privateDetail: "synthetic payload detail" },
}));

for (const mode of ["legacy", "modern"] as const) {
  test(
    `actual stdio MCP (${mode}) lists, searches, traces and summarizes without changing the capture`,
    { timeout: 20_000 },
    async (t) => {
      const directory = await mkdtemp(
        join(await realpath(tmpdir()), "backend-logs-mcp-stdio-"),
      );
      t.after(() => rm(directory, { recursive: true, force: true }));
      const file = join(directory, "capture.jsonl");
      const bytes = `${[...fixtures, ...serviceFixtures].map((row) => JSON.stringify(row)).join("\n")}\n`;
      await writeFile(file, bytes, { mode: 0o600 });
      const before = await stat(file);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entrypoint],
        env: { ...process.env, MUSICMUTE_LOG_CAPTURE: file } as Record<
          string,
          string
        >,
        cwd: tmpdir(),
        stderr: "pipe",
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const client = new Client(
        { name: "backend-log-stdio-regression", version: "1.0.0" },
        mode === "modern"
          ? {
              versionNegotiation: {
                mode: { pin: "2026-07-28" },
                probe: { timeoutMs: 5000 },
              },
            }
          : undefined,
      );
      t.after(async () => {
        await client.close();
      });
      await client.connect(transport, { timeout: 5000 });
      const listing = await client.listTools();
      assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), [
        "error_summary",
        "list_log_archives",
        "search_logs",
        "trace_events",
        "trace_request",
      ]);
      for (const tool of listing.tools) {
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.annotations?.openWorldHint, false);
      }
      const searchCall = await client.callTool({
        name: "search_logs",
        arguments: { route: "/messages" },
      });
      assert.equal(searchCall.isError, undefined);
      const search =
        searchCall.structuredContent as unknown as SearchLogsResult;
      assert.equal(search.available, true);
      assert.equal(search.records.length, 1);
      assert.equal(search.records[0].payload, undefined);
      const fullCall = await client.callTool({
        name: "search_logs",
        arguments: { query: "synthetic fixture", includePayloads: true },
      });
      const full = fullCall.structuredContent as unknown as SearchLogsResult;
      assert.equal(full.records.length, 1);
      assert.match(JSON.stringify(full), /\[REDACTED\]/);
      const traceCall = await client.callTool({
        name: "trace_request",
        arguments: { requestId: "trace-1" },
      });
      const trace =
        traceCall.structuredContent as unknown as TraceRequestResult;
      assert.equal(trace.records.length, 3);
      assert.equal(trace.publications.length, 1);
      assert.equal(trace.publications[0].attempts, 2);
      assert.equal(trace.publications[0].failedAttempts, 1);
      assert.equal(trace.publications[0].providerAccepted, true);
      assert.equal(trace.publications[0].clientReceiptObserved, false);
      const summaryCall = await client.callTool({
        name: "error_summary",
        arguments: {},
      });
      const summary =
        summaryCall.structuredContent as unknown as ErrorSummaryResult;
      assert.equal(summary.http5xx, 1);
      assert.equal(summary.realtimeFailedAttempts, 1);
      assert.equal(summary.totalFailures, 2);
      for (const source of [
        "backend",
        "web-client",
        "redis",
        "mongodb",
        "macos",
        "collector",
      ]) {
        const call = await client.callTool({
          name: "search_logs",
          arguments: { source },
        });
        assert.notEqual(call.isError, true);
        const result = call.structuredContent as unknown as SearchLogsResult;
        assert.ok(result.records.length > 0);
        assert.ok(result.records.every((row) => row.source === source));
        assert.doesNotMatch(JSON.stringify(result), /synthetic payload detail/);
      }
      const inspectorCall = await client.callTool({
        name: "trace_events",
        arguments: {
          source: "web-client",
          instanceId: "web-client-a",
          traceId: "t19",
          captureId: "capture-a",
          sessionGeneration: 3,
        },
      });
      assert.notEqual(inspectorCall.isError, true);
      const inspector =
        inspectorCall.structuredContent as unknown as TraceEventsResult;
      assert.equal(inspector.records.length, 1);
      assert.equal(inspector.records[0].spanId, "s21");
      assert.equal(inspector.records[0].durationMicros, 265300);
      assert.match(inspector.semantics, /No associations/);
      assert.equal(await readFile(file, "utf8"), bytes);
      const after = await stat(file);
      assert.equal(after.mode, before.mode);
      assert.equal(after.mtimeMs, before.mtimeMs);
      await appendFile(
        file,
        `${JSON.stringify({ ...base, event: "http_request", requestId: "new-append", method: "GET", route: "/health", status: 200 })}\n`,
      );
      const appendedCall = await client.callTool({
        name: "search_logs",
        arguments: { requestId: "new-append" },
      });
      const appended =
        appendedCall.structuredContent as unknown as SearchLogsResult;
      assert.equal(appended.records.length, 1);
      assert.equal(appended.records[0].requestId, "new-append");
      await client.close();
      assert.equal(stderr, "");
    },
  );
}
