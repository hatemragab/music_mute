import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  readFile,
  symlink,
  chmod,
  unlink,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  discoverMusicMuteJournals,
  addNativeJournalSources,
} from "./native-journals.mjs";
import {
  journalCodes,
  companionEvents,
  warningStages,
  cloudReplyValidationReasons,
} from "./native-journal-inventory.mjs";
import { startCollector, pathsFor } from "./collector.mjs";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return Date.now() - start;
    await pause(25);
  }
  throw Error("Expected native journal observation unavailable");
}
async function records(paths) {
  return (await readFile(paths.events, "utf8")).split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}
async function fixture(t, cleanup = true) {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "musicmute-native-journal-"),
  );
  if (cleanup) t.after(() => rm(directory, { recursive: true, force: true }));
  const logs = join(
    directory,
    "home",
    "Library",
    "Application Support",
    "MusicMuteLocal",
    "logs",
  );
  await mkdir(logs, { recursive: true, mode: 0o700 });
  return { directory, home: join(directory, "home"), logs };
}
const ui = (session, extra = {}) => ({
  schema_version: 1,
  at: new Date().toISOString(),
  session_id: session,
  event: "app_operation_error",
  code: "APP_STATUS_FAILED",
  command: "status",
  ...extra,
});
const companion = (session, extra = {}) => ({
  schema_version: 1,
  recorded_at: new Date().toISOString(),
  session_id: session,
  sequence: 2,
  component: "extension",
  severity: "error",
  event: "diagnostic_error",
  code: "COMPANION_UNAVAILABLE",
  ...extra,
});
const append = (path, value) => appendFile(path, JSON.stringify(value) + "\n");
async function extraJournals(logs, initial = "{}\n") {
  for (const name of ["desktop", "setup"]) {
    await mkdir(join(logs, name), { mode: 0o700 });
    await writeFile(join(logs, name, "events.jsonl"), initial, { mode: 0o600 });
  }
}

test("fixed journal discovery rejects symlinks/nonprivate files and exposes no arbitrary path setting", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.logs, "ui-events.jsonl"), "{}\n", { mode: 0o600 });
  await writeFile(join(f.logs, "events.jsonl"), "{}\n", { mode: 0o600 });
  await extraJournals(f.logs);
  const first = await discoverMusicMuteJournals(f.home);
  assert.deepEqual(Object.keys(first.files), [
    "macos_ui",
    "macos_companion",
    "macos_desktop",
    "macos_setup",
  ]);
  assert.deepEqual(first.missing, []);
  await symlink(
    join(f.logs, "ui-events.jsonl"),
    join(f.logs, "ui-events.jsonl.1"),
  );
  assert.deepEqual((await discoverMusicMuteJournals(f.home)).missing, [
    "macos_ui",
  ]);
  await unlink(join(f.logs, "ui-events.jsonl.1"));
  await chmod(join(f.logs, "events.jsonl"), 0o644);
  assert.deepEqual((await discoverMusicMuteJournals(f.home)).missing, [
    "macos_companion",
  ]);
  await chmod(join(f.logs, "events.jsonl"), 0o600);
  await chmod(join(f.logs, "desktop"), 0o755);
  assert.deepEqual((await discoverMusicMuteJournals(f.home)).missing, [
    "macos_desktop",
  ]);
  await chmod(join(f.logs, "desktop"), 0o700);
  const sources = {},
    transforms = {};
  addNativeJournalSources(sources, transforms, "capture", first.files);
  assert.equal(sources.journal_macos_ui.read_from, "end");
  assert.equal(sources.journal_macos_companion.ignore_checkpoints, false);
  assert.ok(
    transforms.normalize_journal_macos_companion.source.includes(
      '"origin": "native_journal"',
    ),
  );
  assert.throws(() =>
    addNativeJournalSources({}, {}, "capture", {
      arbitrary: { kind: "ui", include: ["/etc/passwd"] },
    }),
  );
});

test("mirrored safe-code inventory covers current producer code enums", async () => {
  const sources = await Promise.all(
    [
      "../../chrome-extension/src/shared/diagnostic-codes.ts",
      "../../chrome-extension/src/companion/app-journal.ts",
    ].map((file) => readFile(new URL(file, import.meta.url), "utf8")),
  );
  for (const source of sources)
    for (const match of source.matchAll(/"([A-Z][A-Z0-9_]+)"/g))
      if (
        match[1] !== "UNSAFE_UI_JOURNAL" &&
        match[1] !== "UNSAFE_UI_JOURNAL_ROOT" &&
        match[1] !== "UI_JOURNAL_TOO_LARGE"
      )
        assert.ok(
          journalCodes.includes(match[1]),
          `Safe code inventory needs explicit review: ${match[1]}`,
        );
  assert.ok(companionEvents.includes("job_failed"));
  const diagnostics = await readFile(
    new URL(
      "../../chrome-extension/src/companion/diagnostics.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const warningBlock = diagnostics.match(
    /export const DESKTOP_WARNING_STAGES = \[([\s\S]*?)\] as const;/,
  )?.[1];
  assert.ok(warningBlock, "Expected explicit closed desktop warning stages");
  const producerStages = [...warningBlock.matchAll(/"([a-z_]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...warningStages].sort(), producerStages.sort());
  const accountApi = await readFile(
    new URL(
      "../../chrome-extension/src/companion/account-api.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const reasonBlock = accountApi.match(
    /export const CLOUD_REPLY_VALIDATION_REASONS = \[([\s\S]*?)\] as const;/,
  )?.[1];
  assert.ok(reasonBlock, "Expected explicit closed cloud validation reasons");
  const producerReasons = [...reasonBlock.matchAll(/"([a-z_]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    [...cloudReplyValidationReasons].sort(),
    producerReasons.sort(),
  );
  assert.equal(
    new Set(cloudReplyValidationReasons).size,
    cloudReplyValidationReasons.length,
  );
  assert.ok(
    cloudReplyValidationReasons.every((reason) =>
      /^[a-z_]{1,32}$/.test(reason),
    ),
  );
});

test(
  "real Vector normalizes only native journal metadata and resumes checkpoints after downtime",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, false);
    const session = randomUUID(),
      request = randomUUID(),
      job = randomUUID();
    const uiPath = join(f.logs, "ui-events.jsonl"),
      companionPath = join(f.logs, "events.jsonl");
    await writeFile(
      uiPath,
      JSON.stringify(ui(session, { event: "app_started", code: "NONE" })) +
        "\n",
      { mode: 0o600 },
    );
    await writeFile(
      companionPath,
      JSON.stringify(
        companion(session, {
          event: "companion_started",
          code: "NONE",
          component: "companion",
          severity: "info",
          sequence: 1,
        }),
      ) + "\n",
      { mode: 0o600 },
    );
    await extraJournals(
      f.logs,
      JSON.stringify(
        companion(session, {
          event: "companion_started",
          code: "NONE",
          component: "companion",
          severity: "info",
          sequence: 1,
        }),
      ) + "\n",
    );
    const journals = await discoverMusicMuteJournals(f.home);
    const paths = pathsFor(f.directory);
    let collector;
    t.after(async () => {
      await collector?.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    const options = {
      directory: f.directory,
      keys: { collector: "j".repeat(64) },
      port: 19894,
      nativeFiles: {},
      journalFiles: journals.files,
      interval: 250,
    };
    collector = await startCollector(options);
    // Fresh EOF sources become readable asynchronously. Probe only owned fixture
    // files until every namespace reaches the retained capture before timing
    // subsequent activity; process liveness/checkpoint flush is not readiness.
    await until(async () => {
      await append(
        uiPath,
        ui(session, { event: "app_setup_cancelled", code: "NONE" }),
      );
      for (const name of ["macos_companion", "macos_desktop", "macos_setup"])
        await append(
          journals.files[name].include[0],
          companion(randomUUID(), {
            event: "resource_sample",
            code: "NONE",
            component: "companion",
            severity: "info",
            sequence: 1,
          }),
        );
      const ready = new Set(
        (await records(paths)).map((row) => row.data?.journal),
      );
      return Object.keys(journals.files).every((name) => ready.has(name));
    }, 10000);
    const isNewActivity = (row) =>
      row.origin === "native_journal" &&
      [
        "native_journal.app_operation_error",
        "native_journal.diagnostic_error",
        "native_journal.job_ready",
      ].includes(row.name);
    const marker = "SYNTHETIC_JOURNAL_CREDENTIAL_MUST_NOT_RETAIN";
    await append(
      uiPath,
      ui(session, {
        message: marker,
        password: marker,
        identity: { token: marker },
      }),
    );
    await append(
      companionPath,
      companion(session, {
        request_id: request,
        job_id: job,
        metrics: {
          duration_ms: 17,
          stage: "content",
          url: marker,
          authorization: marker,
        },
        error: marker,
      }),
    );
    await append(
      join(f.logs, "desktop", "events.jsonl"),
      companion(randomUUID(), {
        component: "extension",
        severity: "info",
        event: "job_ready",
        code: "NONE",
        job_id: job,
        sequence: 9,
      }),
    );
    await append(
      join(f.logs, "setup", "events.jsonl"),
      companion(randomUUID(), {
        component: "companion",
        severity: "warning",
        event: "diagnostic_error",
        code: "API_REQUEST_FAILED",
        request_id: request,
        metrics: { stage: "account_file_reuse", http_status: 503 },
        sequence: 7,
      }),
    );
    const elapsed = await until(
      async () => (await records(paths)).filter(isNewActivity).length >= 4,
    ).catch(async (error) => {
      t.diagnostic(
        JSON.stringify({
          observed: (await records(paths)).map((row) => ({
            source: row.source,
            name: row.name,
            journal: row.data?.journal,
            seq: row.seq,
          })),
        }),
      );
      throw error;
    });
    const observed = (await records(paths)).filter(isNewActivity);
    assert.equal(observed.length, 4);
    assert.ok(elapsed < 2000);
    assert.ok(
      (await records(paths)).every(
        (row) =>
          ![
            "native_journal.companion_started",
            "native_journal.app_started",
          ].includes(row.name),
      ),
    );
    assert.equal(
      observed.find((row) => row.data.journal === "macos_desktop").source,
      "macos",
    );
    assert.equal(
      observed.find((row) => row.data.journal === "macos_desktop").result,
      "success",
    );
    assert.equal(
      observed.find((row) => row.data.journal === "macos_setup").level,
      "warn",
    );
    const identifiedWarning = observed.find(
      (row) => row.data.journal === "macos_setup",
    );
    assert.equal(identifiedWarning.operation, "account_file_reuse");
    assert.equal(identifiedWarning.phase, "failed");
    assert.equal(identifiedWarning.result, "failed");
    assert.equal(identifiedWarning.status, 503);
    assert.equal(identifiedWarning.requestId, request);
    assert.equal(identifiedWarning.data.code, "API_REQUEST_FAILED");
    await append(
      join(f.logs, "desktop", "events.jsonl"),
      companion(session, {
        event: "job_cancelled",
        component: "companion",
        severity: "info",
        code: "CANCELLED",
        job_id: job,
        sequence: 10,
      }),
    );
    await until(async () =>
      (await records(paths)).some(
        (row) => row.name === "native_journal.job_cancelled",
      ),
    );
    await append(
      join(f.logs, "setup", "events.jsonl"),
      companion(session, {
        event: "diagnostic_error",
        component: "companion",
        severity: "warning",
        code: "CANCELLED",
        request_id: request,
        metrics: { stage: "local_file_pair_staging" },
        sequence: 11,
      }),
    );
    await until(async () =>
      (await records(paths)).some((row) => row.seq === 11),
    );
    // Decode the actual Vector output through the real read-only MCP SDK.
    // The server reads this isolated fixture capture, never the shared capture.
    const mcpRequire = createRequire(
      new URL("../logs-mcp/package.json", import.meta.url),
    );
    const { Client } = await import(
      pathToFileURL(mcpRequire.resolve("@modelcontextprotocol/client")).href
    );
    const { StdioClientTransport } = await import(
      pathToFileURL(mcpRequire.resolve("@modelcontextprotocol/client/stdio"))
        .href
    );
    const client = new Client({
      name: "native-journal-metadata-test",
      version: "1.0.0",
    });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(
              new URL("../logs-mcp/dist/src/index.js", import.meta.url),
            ),
          ],
          env: { MUSICMUTE_LOG_CAPTURE: paths.events },
          stderr: "pipe",
        }),
      );
      const result = await client.callTool({
        name: "search_logs",
        arguments: {
          source: "macos",
          operation: "account_file_reuse",
          status: 503,
          requestId: request,
          limit: 10,
        },
      });
      assert.ok(!result.isError);
      const metadata = result.structuredContent;
      assert.equal(metadata.records.length, 1);
      assert.equal(metadata.records[0].operation, "account_file_reuse");
      assert.equal(metadata.records[0].phase, "failed");
      assert.equal(metadata.records[0].status, 503);
      assert.equal(metadata.records[0].payload, undefined);
      assert.equal(metadata.coverage.partial, false);
      assert.equal(metadata.coverage.invalidRecords, 0);
      const cancellations = await client.callTool({
        name: "search_logs",
        arguments: { source: "macos", event: "native_journal.job_cancelled" },
      });
      assert.ok(!cancellations.isError);
      assert.equal(cancellations.structuredContent.records.length, 1);
      assert.equal(
        cancellations.structuredContent.records[0].phase,
        "cancelled",
      );
      assert.equal(
        cancellations.structuredContent.records[0].result,
        "cancelled",
      );
      const cancellationSummary = await client.callTool({
        name: "error_summary",
        arguments: { source: "macos", name: "native_journal.job_cancelled" },
      });
      assert.ok(!cancellationSummary.isError);
      assert.equal(cancellationSummary.structuredContent.totalFailures, 0);
      assert.equal(cancellationSummary.structuredContent.failedOperations, 0);
      assert.equal(cancellationSummary.structuredContent.errorRecords, 0);
      const stagedCancellation = await client.callTool({
        name: "search_logs",
        arguments: { source: "macos", operation: "local_file_pair_staging" },
      });
      assert.ok(!stagedCancellation.isError);
      assert.equal(stagedCancellation.structuredContent.records.length, 1);
      assert.equal(
        stagedCancellation.structuredContent.records[0].level,
        "warn",
      );
      assert.equal(
        stagedCancellation.structuredContent.records[0].phase,
        "cancelled",
      );
      assert.equal(
        stagedCancellation.structuredContent.records[0].result,
        "cancelled",
      );
      const stagedSummary = await client.callTool({
        name: "error_summary",
        arguments: { source: "macos", operation: "local_file_pair_staging" },
      });
      assert.ok(!stagedSummary.isError);
      assert.equal(stagedSummary.structuredContent.warningRecords, 1);
      assert.equal(stagedSummary.structuredContent.failedOperations, 0);
      assert.equal(stagedSummary.structuredContent.warningOnlyRecords, 1);
      assert.equal(stagedSummary.structuredContent.errorRecords, 0);
      assert.equal(
        stagedSummary.structuredContent.totalErrorsAndFailedOperations,
        0,
      );
    } finally {
      await client.close();
    }
    const browser = observed.find((row) => row.source === "chrome-extension");
    assert.equal(browser.instanceId, session);
    assert.equal(browser.requestId, request);
    assert.equal(browser.jobId, job);
    assert.equal(browser.durationMs, 17);
    assert.equal(browser.data.stage, "content");
    assert.equal(browser.result, "failed");
    assert.equal(browser.seq, 2);
    assert.equal(browser.timestampSource, "service");
    assert.doesNotMatch(JSON.stringify(observed), new RegExp(marker));
    await append(
      companionPath,
      companion(session, {
        sequence: 3,
        code: marker,
        message: marker,
        metrics: { stage: "account_forged", http_status: 503 },
      }),
    );
    await until(async () =>
      (await records(paths)).some((row) => row.seq === 3),
    );
    assert.equal(
      (await records(paths)).find((row) => row.seq === 3).data.code,
      "UNKNOWN_ERROR",
    );
    const unknownWarning = (await records(paths)).find((row) => row.seq === 3);
    assert.equal(unknownWarning.operation, "diagnostic_error");
    assert.equal(unknownWarning.status, undefined);
    assert.equal(unknownWarning.phase, undefined);
    await collector.close();
    collector = null;
    await append(
      companionPath,
      companion(session, {
        sequence: 4,
        component: "companion",
        severity: "warning",
        event: "diagnostic_error",
        code: "TOOL_TIMEOUT",
      }),
    );
    collector = await startCollector(options);
    await until(async () =>
      (await records(paths)).some((row) => row.seq === 4),
    );
    const all = await records(paths);
    assert.equal(all.filter((row) => row.seq === 2).length, 1);
    assert.equal(all.find((row) => row.seq === 4).level, "warn");
    assert.doesNotMatch(JSON.stringify(all), new RegExp(marker));
  },
);

test(
  "real Vector retains only closed cloud validation reasons in explicitly requested MCP payloads",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, false);
    await extraJournals(f.logs);
    const journals = await discoverMusicMuteJournals(f.home);
    const path = join(f.logs, "desktop", "events.jsonl");
    const paths = pathsFor(f.directory);
    let collector;
    t.after(async () => {
      await collector?.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    collector = await startCollector({
      directory: f.directory,
      keys: { collector: "r".repeat(64) },
      port: 19895,
      nativeFiles: {},
      journalFiles: { macos_desktop: journals.files.macos_desktop },
      interval: 250,
    });
    await until(async () => {
      await append(
        path,
        companion(randomUUID(), {
          component: "companion",
          severity: "info",
          event: "resource_sample",
          code: "NONE",
        }),
      );
      return (await records(paths)).some(
        (row) => row.data?.journal === "macos_desktop",
      );
    }, 10000);
    const session = randomUUID(),
      request = randomUUID(),
      marker = "SYNTHETIC_VALIDATION_REASON_CREDENTIAL_MUST_NOT_RETAIN";
    // Vector parses JSON, so accessor/prototype-shaped objects are values rather
    // than JavaScript accessors. Only an exact primitive string may survive.
    const invalidReasons = [
      marker,
      `input_hash:${marker}`,
      ["input_hash"],
      { value: "input_hash" },
      null,
      7,
      true,
      JSON.parse('{"__proto__":{"validation_reason":"input_hash"}}'),
      { get: marker },
      "constructor",
    ];
    for (const [index, reason] of cloudReplyValidationReasons.entries())
      await append(
        path,
        companion(session, {
          component: "companion",
          severity: "warning",
          code: "CLOUD_REPLY_INVALID",
          request_id: request,
          sequence: 1000 + index,
          metrics: {
            stage: "account_owner_link",
            validation_reason: reason,
            [marker]: marker,
          },
        }),
      );
    for (const [index, reason] of invalidReasons.entries())
      await append(
        path,
        companion(session, {
          component: "companion",
          severity: "warning",
          code: "CLOUD_REPLY_INVALID",
          request_id: request,
          sequence: 2000 + index,
          metrics: { stage: "account_owner_link", validation_reason: reason },
        }),
      );
    await append(
      path,
      companion(session, {
        component: "companion",
        severity: "warning",
        code: "API_REQUEST_FAILED",
        request_id: request,
        sequence: 3000,
        metrics: {
          stage: "account_owner_link",
          validation_reason: "input_hash",
        },
      }),
    );
    const count =
      cloudReplyValidationReasons.length + invalidReasons.length + 1;
    await until(
      async () =>
        (await records(paths)).filter((row) => row.requestId === request)
          .length === count,
    );
    const observed = (await records(paths)).filter(
      (row) => row.requestId === request,
    );
    assert.equal(observed.length, count);
    for (const [index, reason] of cloudReplyValidationReasons.entries()) {
      const row = observed.find((item) => item.seq === 1000 + index);
      assert.equal(row.data.metrics.validation_reason, reason);
      assert.equal(row.data.validationReasonOmitted, undefined);
      assert.equal(row.operation, "account_owner_link");
      assert.equal(row.result, "failed");
    }
    for (const row of observed.filter((item) => item.seq >= 2000)) {
      assert.equal(row.data.metrics.validation_reason, undefined);
      assert.equal(row.data.validationReasonOmitted, true);
    }
    assert.doesNotMatch(
      JSON.stringify(await records(paths)),
      new RegExp(marker),
    );
    const mcpRequire = createRequire(
      new URL("../logs-mcp/package.json", import.meta.url),
    );
    const { Client } = await import(
      pathToFileURL(mcpRequire.resolve("@modelcontextprotocol/client")).href
    );
    const { StdioClientTransport } = await import(
      pathToFileURL(mcpRequire.resolve("@modelcontextprotocol/client/stdio"))
        .href
    );
    const client = new Client({
      name: "native-journal-validation-reason-test",
      version: "1.0.0",
    });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(
              new URL("../logs-mcp/dist/src/index.js", import.meta.url),
            ),
          ],
          env: { MUSICMUTE_LOG_CAPTURE: paths.events },
          stderr: "pipe",
        }),
      );
      const query = { source: "macos", requestId: request, limit: 100 };
      const metadata = await client.callTool({
        name: "search_logs",
        arguments: query,
      });
      assert.ok(!metadata.isError);
      assert.equal(metadata.structuredContent.records.length, count);
      assert.ok(
        metadata.structuredContent.records.every(
          (row) => row.payload === undefined,
        ),
      );
      const payloads = await client.callTool({
        name: "search_logs",
        arguments: { ...query, includePayloads: true },
      });
      assert.ok(!payloads.isError);
      assert.equal(payloads.structuredContent.coverage.partial, false);
      assert.equal(payloads.structuredContent.coverage.invalidRecords, 0);
      const reasons = payloads.structuredContent.records
        .map((row) => row.payload?.data?.metrics?.validation_reason)
        .filter((reason) => reason !== undefined);
      assert.deepEqual(reasons.sort(), [...cloudReplyValidationReasons].sort());
      assert.doesNotMatch(JSON.stringify(payloads), new RegExp(marker));
    } finally {
      await client.close();
    }
  },
);
