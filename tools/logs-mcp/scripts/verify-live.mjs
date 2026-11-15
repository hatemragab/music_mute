import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const client = new Client({
  name: "musicmute-local-verifier",
  version: "1.0.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "tools/logs-mcp/dist/src/index.js")],
  stderr: "pipe",
});
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const probe = JSON.parse(
    await readFile(
      join(root, ".runtime/local-logging/last-probe.json"),
      "utf8",
    ),
  );
  const results = {
    tools,
    capture: ".runtime/local-logging/events.jsonl",
    sources: {},
  };
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
  ]) {
    const call = await client.callTool({
      name: "search_logs",
      arguments: { source, limit: 5 },
    });
    if (call.isError) throw Error("MCP source query rejected");
    const value = call.structuredContent;
    results.sources[source] = {
      records: value.records.length,
      partial: value.coverage.partial,
      warnings: value.warnings,
    };
  }
  for (const [name, args] of [
    [
      "trace_events",
      {
        source: "collector",
        instanceId: probe.instanceId,
        traceId: probe.traceId,
        includePayloads: true,
      },
    ],
    ["trace_request", { requestId: "00000000-0000-4000-8000-000000000000" }],
    ["error_summary", {}],
    ["list_log_archives", {}],
  ]) {
    const call = await client.callTool({ name, arguments: args });
    if (call.isError) throw Error("MCP tool call failed");
    const value = call.structuredContent;
    results[name] = {
      available: value.available,
      records: value.records?.length,
      archives: value.archives?.length,
      errors: value.errorRecords,
      warnings: value.warningRecords ?? value.warnings,
      partial: value.coverage?.partial,
    };
    if (name === "trace_events" && value.records.length !== 1)
      throw Error("Probe trace not found in the configured capture");
  }
  const nativeSearch = await client.callTool({
    name: "search_logs",
    arguments: { source: "ios", limit: 20 },
  });
  const native = (nativeSearch.structuredContent?.records ?? []).find(
    (record) => record.traceId && record.instanceId,
  );
  if (native) {
    const call = await client.callTool({
      name: "trace_events",
      arguments: {
        source: "ios",
        instanceId: native.instanceId,
        traceId: native.traceId,
        includePayloads: true,
        limit: 20,
      },
    });
    if (call.isError) throw Error("Native trace query failed");
    results.nativeTrace = {
      records: call.structuredContent.records.length,
      events: call.structuredContent.records.map((record) => ({
        name: record.name,
        status: record.status,
        result: record.result,
      })),
      partial: call.structuredContent.coverage.partial,
    };
    const summary = await client.callTool({
      name: "error_summary",
      arguments: { source: "ios", instanceId: native.instanceId },
    });
    if (summary.isError) throw Error("Native error summary failed");
    results.nativeSummary = {
      warningRecords: summary.structuredContent.warningRecords,
      errorRecords: summary.structuredContent.errorRecords,
      failedOperations: summary.structuredContent.failedOperations,
      deduplicated: summary.structuredContent.totalErrorsAndFailedOperations,
    };
  }
  const text = JSON.stringify(results, null, 2);
  await writeFile(
    join(root, ".runtime/local-logging/mcp-live-verification.json"),
    text,
    { mode: 0o600 },
  );
  console.log(text);
} finally {
  await client.close();
}
