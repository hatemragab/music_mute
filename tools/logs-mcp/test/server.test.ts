import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createBackendLogsServer,
  type BackendLogQueries,
} from "../src/server.js";
import {
  errorSummaryOutputSchema,
  searchLogsOutputSchema,
  traceRequestOutputSchema,
  traceEventsOutputSchema,
  listLogArchivesOutputSchema,
} from "../src/schemas.js";
import type {
  ErrorSummaryResult,
  LogCoverage,
  SearchLogsResult,
  TraceRequestResult,
} from "../src/types.js";

const coverage: LogCoverage = {
  snapshotBytes: 0,
  scannedFromByte: 0,
  scannedToByte: 0,
  readBytes: 0,
  scannedRecords: 0,
  malformedLines: 0,
  invalidRecords: 0,
  oversizedLines: 0,
  incompleteTrailingLine: false,
  skippedBoundaryBytes: 0,
  olderRecordsAvailable: false,
  partial: false,
  resultLimited: false,
  payloadsOmitted: 0,
  metadataTruncated: 0,
};
const searchResult: SearchLogsResult = {
  available: true,
  coverage,
  warnings: [],
  records: [],
};
const traceResult: TraceRequestResult = {
  ...searchResult,
  publications: [],
  semantics: "Provider acceptance does not establish client receipt.",
};
const summaryResult: ErrorSummaryResult = {
  available: true,
  coverage,
  warnings: [],
  totalFailures: 0,
  warningRecords: 0,
  errorRecords: 0,
  failedOperations: 0,
  warningOnlyRecords: 0,
  totalErrorsAndFailedOperations: 0,
  semantics: "Explicit counters describe separate overlapping dimensions.",
  http4xx: 0,
  http5xx: 0,
  httpAborts: 0,
  realtimeFailedAttempts: 0,
  genericFailures: 0,
  groups: [],
  groupsOmitted: 0,
};

function queries(
  overrides: Partial<BackendLogQueries> = {},
): BackendLogQueries {
  return {
    searchLogs: async () => searchResult,
    traceRequest: async () => traceResult,
    traceEvents: async () => ({
      ...searchResult,
      semantics: "Explicit source and instance scope only.",
    }),
    errorSummary: async () => summaryResult,
    listLogArchives: async () => ({
      available: false,
      archives: [],
      inspectedEntries: 0,
      unsafeEntries: 0,
      truncated: false,
      warnings: [],
      semantics: "Separate captures.",
    }),
    ...overrides,
  };
}

async function connect(
  t: TestContext,
  store: string | BackendLogQueries = queries(),
): Promise<Client> {
  const server = createBackendLogsServer(store);
  const client = new Client({ name: "backend-log-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test("SDK initialize, ping and discovery expose five read-only tools", async (t) => {
  const client = await connect(t);
  assert.equal(client.getServerVersion()?.name, "musicmute-local-logs");
  assert.ok(client.getServerCapabilities()?.tools);
  assert.match(client.getInstructions() ?? "", /untrusted data/);
  assert.match(client.getInstructions() ?? "", /coverage and warnings/);
  assert.deepEqual(await client.ping(), {});
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "error_summary",
    "list_log_archives",
    "search_logs",
    "trace_events",
    "trace_request",
  ]);
  for (const tool of tools) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema?.type, "object");
    assert.ok(tool.outputSchema?.properties);
    assert.equal((tool.inputSchema.properties ?? {}).file, undefined);
    assert.equal((tool.inputSchema.properties ?? {}).path, undefined);
  }
});

test("SDK calls return validated structured output for all tools", async (t) => {
  const client = await connect(t);
  const cases = [
    ["search_logs", {}, searchLogsOutputSchema, searchResult],
    [
      "trace_request",
      { requestId: "request-1" },
      traceRequestOutputSchema,
      traceResult,
    ],
    ["error_summary", {}, errorSummaryOutputSchema, summaryResult],
    [
      "trace_events",
      { source: "web-client", instanceId: "tab-a", traceId: "t19" },
      traceEventsOutputSchema,
      {
        ...searchResult,
        semantics: "Explicit source and instance scope only.",
      },
    ],
  ] as const;
  for (const [name, args, schema, expected] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true);
    assert.deepEqual(schema.parse(result.structuredContent), expected);
    assert.match(JSON.stringify(result.content), /Untrusted local log data/);
  }
});

test("the shipped factory reads one capture, paginates and returns metadata unless payloads are requested", async (t) => {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "backend-logs-mcp-server-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "capture.jsonl");
  const base = {
    timestamp: "2026-10-16T12:00:00.000Z",
    source: "backend",
    requestId: "request-1",
    userId: "actor-1",
  };
  const rows = [
    {
      ...base,
      event: "http_request",
      level: "error",
      method: "POST",
      route: "/messages",
      status: 500,
      responseBody: { message: "Synthetic failure", token: "[REDACTED]" },
    },
    {
      ...base,
      event: "realtime_publication",
      level: "warn",
      actorUserId: "actor-1",
      recipientUserId: "recipient-1",
      eventType: "message_new",
      publicationId: "publication-1",
      attempt: 1,
      result: "failure",
      status: 503,
      data: { message: "Synthetic message" },
    },
    {
      ...base,
      event: "realtime_publication",
      level: "info",
      actorUserId: "actor-1",
      recipientUserId: "recipient-1",
      eventType: "message_new",
      publicationId: "publication-1",
      attempt: 2,
      result: "success",
      status: 200,
    },
  ] as const;
  const original = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(file, original, { mode: 0o600 });
  const client = await connect(t, file);

  const search = searchLogsOutputSchema.parse(
    (await client.callTool({ name: "search_logs", arguments: {} }))
      .structuredContent,
  );
  assert.equal(search.records.length, 3);
  assert.ok(search.records.every((record) => record.payload === undefined));
  assert.equal(search.coverage.partial, false);

  const first = searchLogsOutputSchema.parse(
    (await client.callTool({ name: "search_logs", arguments: { limit: 1 } }))
      .structuredContent,
  );
  assert.equal(first.records.length, 1);
  assert.ok(first.nextCursor);
  const second = searchLogsOutputSchema.parse(
    (
      await client.callTool({
        name: "search_logs",
        arguments: { limit: 1, cursor: first.nextCursor },
      })
    ).structuredContent,
  );
  assert.equal(second.records[0]?.attempt, 1);

  const payloads = searchLogsOutputSchema.parse(
    (
      await client.callTool({
        name: "search_logs",
        arguments: { event: "http_request", includePayloads: true },
      })
    ).structuredContent,
  );
  assert.deepEqual(
    payloads.records[0]?.payload?.responseBody,
    rows[0]?.responseBody,
  );

  const trace = traceRequestOutputSchema.parse(
    (
      await client.callTool({
        name: "trace_request",
        arguments: { requestId: "request-1" },
      })
    ).structuredContent,
  );
  assert.equal(trace.records.length, 3);
  assert.deepEqual(trace.publications[0], {
    publicationId: "publication-1",
    actorUserId: "actor-1",
    recipientUserId: "recipient-1",
    eventType: "message_new",
    attempts: 2,
    failedAttempts: 1,
    providerAccepted: true,
    clientReceiptObserved: false,
  });
  const summary = errorSummaryOutputSchema.parse(
    (await client.callTool({ name: "error_summary", arguments: {} }))
      .structuredContent,
  );
  assert.equal(summary.totalFailures, 2);
  assert.equal(summary.http5xx, 1);
  assert.equal(summary.realtimeFailedAttempts, 1);
  assert.equal(await readFile(file, "utf8"), original);
});

test("all invalid arguments are rejected by SDK before the query engine runs", async (t) => {
  let calls = 0;
  const client = await connect(
    t,
    queries({
      searchLogs: async () => {
        calls++;
        return searchResult;
      },
      traceRequest: async () => {
        calls++;
        return traceResult;
      },
      errorSummary: async () => {
        calls++;
        return summaryResult;
      },
    }),
  );
  const invalid: [string, Record<string, unknown>][] = [
    ["search_logs", { file: "/private/credentials" }],
    ["search_logs", { query: "" }],
    ["search_logs", { query: "x".repeat(501) }],
    ["search_logs", { query: "hello\u0000world" }],
    ["search_logs", { requestId: "x".repeat(129) }],
    ["search_logs", { event: "x".repeat(129) }],
    ["search_logs", { level: "verbose" }],
    ["search_logs", { method: "arbitrary" }],
    ["search_logs", { status: 600 }],
    ["search_logs", { status: 99 }],
    ["search_logs", { status: 404.5 }],
    ["search_logs", { from: "2026-10-16T12:00:00" }],
    ["search_logs", { from: "2026-02-30T12:00:00Z" }],
    [
      "search_logs",
      { from: "2026-10-17T12:00:00Z", to: "2026-10-16T12:00:00Z" },
    ],
    ["search_logs", { limit: 201 }],
    ["search_logs", { limit: 0 }],
    ["search_logs", { limit: "10" }],
    ["search_logs", { cursor: "../credentials" }],
    ["search_logs", { includePayloads: "true" }],
    ["trace_events", {}],
    ["trace_events", { source: "web-client", traceId: "t19" }],
    [
      "trace_events",
      {
        source: "web-client",
        instanceId: "tab-a",
        traceId: "t19",
        sessionGeneration: -1,
      },
    ],
    ["search_logs", { source: "untrusted" }],
    ["trace_request", {}],
    ["trace_request", { requestId: "" }],
    ["trace_request", { requestId: "request-1", limit: 201 }],
    ["trace_request", { requestId: "request-1", file: "/private/credentials" }],
    ["error_summary", { limit: 101 }],
    ["error_summary", { query: "unsupported" }],
    ["error_summary", { from: "yesterday" }],
    [
      "error_summary",
      { from: "2026-10-17T00:00:00Z", to: "2026-10-16T00:00:00Z" },
    ],
  ];
  for (const [name, args] of invalid) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(args)}`);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await client.ping(), {});
});

test("validation responses do not echo rejected secrets or arbitrary object keys", async (t) => {
  const client = await connect(t);
  for (const args of [
    { level: "secret-access-value" },
    { "secret-object-key": "secret-access-value" },
    { from: "secret-access-value" },
    { includePayloads: "secret-access-value" },
  ]) {
    const result = await client.callTool({
      name: "search_logs",
      arguments: args,
    });
    assert.equal(result.isError, true);
    assert.doesNotMatch(
      JSON.stringify(result),
      /secret-access-value|secret-object-key/,
    );
  }
});

test("valid literal filters and timezone offsets reach the engine unchanged", async (t) => {
  const input = {
    query: ".*[message]?",
    method: "POST",
    status: 500,
    from: "2026-10-16T12:00:00+03:00",
    to: "2026-10-16T10:00:00Z",
    limit: 200,
    includePayloads: true,
  };
  let observed: unknown;
  const client = await connect(
    t,
    queries({
      searchLogs: async (args) => {
        observed = args;
        return searchResult;
      },
    }),
  );
  const result = await client.callTool({
    name: "search_logs",
    arguments: input,
  });
  assert.notEqual(result.isError, true);
  assert.deepEqual(observed, input);
});

test("unexpected query failures have fixed messages without paths, credentials or stacks", async (t) => {
  const fail = async (): Promise<never> => {
    throw new Error(
      "secret-token from /private/account.env at SomeService (source.ts:1)",
    );
  };
  const client = await connect(
    t,
    queries({
      searchLogs: fail,
      traceRequest: fail,
      traceEvents: fail,
      errorSummary: fail,
    }),
  );
  for (const [name, args] of [
    ["search_logs", {}],
    ["trace_request", { requestId: "request-1" }],
    ["error_summary", {}],
    [
      "trace_events",
      { source: "web-client", instanceId: "tab-a", traceId: "t19" },
    ],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.match(
      JSON.stringify(result.content),
      /Backend logs could not be queried/,
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /secret-token|\/private|source\.ts|SomeService/,
    );
    assert.equal(result.structuredContent, undefined);
  }
});

test("invalid engine output is contained before SDK serialization", async (t) => {
  const client = await connect(
    t,
    queries({
      searchLogs: async () => ({
        ...searchResult,
        privateUnknownField: "secret-token",
      }),
    }),
  );
  const result = await client.callTool({ name: "search_logs", arguments: {} });
  assert.equal(result.isError, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret-token|privateUnknownField/,
  );
});

test("concurrent queries are bounded and a busy response does not enter the engine", async (t) => {
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = await connect(
    t,
    queries({
      searchLogs: async () => {
        calls++;
        await pending;
        return searchResult;
      },
    }),
  );
  const first = client.callTool({ name: "search_logs", arguments: {} });
  const second = client.callTool({ name: "search_logs", arguments: {} });
  const third = client.callTool({ name: "search_logs", arguments: {} });
  try {
    const result = await third;
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /busy/);
    assert.equal(calls, 2);
  } finally {
    release();
  }
  const completed = await Promise.all([first, second]);
  assert.ok(completed.every((result) => result.isError !== true));
  assert.notEqual(
    (await client.callTool({ name: "error_summary", arguments: {} })).isError,
    true,
  );
});

test("unknown tool names are rejected and the server remains usable", async (t) => {
  const client = await connect(t);
  await assert.rejects(
    client.callTool({ name: "write_logs", arguments: {} }),
    /not found/,
  );
  assert.deepEqual(await client.ping(), {});
});

test("SDK discovers retained archives and reads the exact selected capture without changing defaults", async (t) => {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "backend-logs-mcp-archives-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "events.jsonl");
  const archives = join(directory, "archives");
  await mkdir(archives, { mode: 0o700 });
  const id = "events.20261017T003000123Z-ab12cd34.jsonl";
  const base = {
    timestamp: "2026-10-17T00:30:00.123Z",
    source: "mongodb",
    event: "service_log",
    requestId: null,
    userId: null,
    level: "warn",
    sourceEventCode: "22430",
    timestampSource: "service",
    sourceTimestamp: "2026-10-17T00:29:59Z",
    receivedAt: "2026-10-17T00:30:01Z",
  };
  await writeFile(file, JSON.stringify({ ...base, level: "info" }) + "\n", {
    mode: 0o600,
  });
  const original = JSON.stringify(base) + "\n";
  await writeFile(join(archives, id), original, { mode: 0o600 });
  const client = await connect(t, file);
  const listing = listLogArchivesOutputSchema.parse(
    (await client.callTool({ name: "list_log_archives", arguments: {} }))
      .structuredContent,
  );
  assert.equal(listing.archives[0].id, id);
  const archived = searchLogsOutputSchema.parse(
    (await client.callTool({ name: "search_logs", arguments: { archive: id } }))
      .structuredContent,
  );
  assert.equal(archived.records[0].sourceEventCode, "22430");
  assert.equal(archived.records[0].sourceTimestamp, "2026-10-17T00:29:59.000Z");
  const summary = errorSummaryOutputSchema.parse(
    (
      await client.callTool({
        name: "error_summary",
        arguments: { archive: id },
      })
    ).structuredContent,
  );
  assert.equal(summary.totalFailures, 1);
  assert.equal(summary.warningOnlyRecords, 1);
  assert.equal(summary.totalErrorsAndFailedOperations, 0);
  assert.equal(summary.failedOperations, 0);
  const live = searchLogsOutputSchema.parse(
    (await client.callTool({ name: "search_logs", arguments: {} }))
      .structuredContent,
  );
  assert.equal(live.records[0].level, "info");
  assert.equal(await readFile(join(archives, id), "utf8"), original);
  const invalid = await client.callTool({
    name: "search_logs",
    arguments: { archive: "../events.jsonl" },
  });
  assert.equal(invalid.isError, true);
  const invalidList = await client.callTool({
    name: "list_log_archives",
    arguments: { path: directory },
  });
  assert.equal(invalidList.isError, true);
  assert.doesNotMatch(JSON.stringify(invalidList), new RegExp(directory));
});
