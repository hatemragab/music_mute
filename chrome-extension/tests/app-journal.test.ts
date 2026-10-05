import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readAppUiJournal,
  type AppUiEvent,
  type AppUiFields,
} from "../src/companion/app-journal.js";
import {
  Diagnostics,
  type DiagnosticReport,
} from "../src/companion/diagnostics.js";
import { resolveDiagnosticIdentity } from "../src/companion/diagnostic-identity.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
const diagnostics: Diagnostics[] = [];
const privateValues = [
  "https://private.example/watch?token=fixture-secret",
  "fixture-secret-token",
  "/private/fixture/audio.mp3",
  "private raw stderr fixture",
] as const;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockReset();
  for (const writer of diagnostics.splice(0)) writer.close();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-ui-journal-test-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
function event(index = 0): AppUiEvent {
  return {
    schema_version: 1,
    at: new Date(Date.UTC(2026, 9, 2) + index * 1000).toISOString(),
    session_id: "11111111-1111-4111-8111-111111111111",
    event: "app_operation_error",
    code: "APP_COMMAND_FAILED",
    command: "setup",
  };
}
function recordWithPrivateExtras(index = 0): Record<string, unknown> {
  return {
    ...event(index),
    source_url: privateValues[0],
    token: privateValues[1],
    path: privateValues[2],
    raw_error: privateValues[3],
    metrics: { source_url: privateValues[0], token: privateValues[1] },
    nested: { file: privateValues[2], stderr: privateValues[3] },
  };
}
async function journal(
  root: string,
  records: unknown[],
  name = "ui-events.jsonl",
): Promise<string> {
  const path = join(root, name);
  await writeFile(
    path,
    records.map((value) => JSON.stringify(value)).join("\n") + "\n",
    {
      mode: 0o600,
    },
  );
  return path;
}
function expectNoPrivateValues(value: unknown): void {
  const encoded = JSON.stringify(value);
  for (const privateValue of privateValues)
    expect(encoded).not.toContain(privateValue);
}
function writer(root: string, readOnly = false): Diagnostics {
  const value = new Diagnostics(root, {
    readOnly,
    now: () => Date.UTC(2026, 9, 2),
    monotonic: () => 0,
  });
  diagnostics.push(value);
  return value;
}

describe("native app UI journal projection and retained history", () => {
  it("preserves safe historical app identity without restamping legacy or malformed records", async () => {
    const root = await fixture();
    const identity = {
      software_version: "0.0.1-alpha",
      runtime_scope: "PACKAGED_APP",
      expected_model_sha256: "a".repeat(64),
      package_inventory_sha256: "b".repeat(64),
    };
    const records = [
      event(0),
      { ...event(1), identity: null },
      {
        ...event(2),
        identity: { ...identity, private_path: privateValues[2] },
      },
      {
        ...event(3),
        identity: { ...identity, package_inventory_sha256: null },
      },
      {
        ...event(4),
        identity: { ...identity, software_version: privateValues[0] },
      },
      {
        ...event(5),
        identity: { ...identity, expected_model_sha256: privateValues[1] },
      },
    ];
    const path = await journal(root, records);
    const before = await readFile(path);
    const fields = await readAppUiJournal(root);
    expect(fields.app_ui_events.slice(0, 2)).toEqual([event(0), event(1)]);
    expect(fields.app_ui_events[2]?.identity).toEqual(identity);
    const { package_inventory_sha256: _inventory, ...withoutInventory } =
      identity;
    expect(fields.app_ui_events[3]?.identity).toEqual(withoutInventory);
    expect(fields.app_ui_events.slice(4)).toEqual([event(4), event(5)]);
    expect(fields.app_ui_coverage.malformed_records).toBe(2);
    expect(fields.app_ui_coverage.history_truncated).toBe(true);
    expectNoPrivateValues(fields);
    expect(await readFile(path)).toEqual(before);
    const current = new Diagnostics(root, {
      readOnly: true,
      identity: resolveDiagnosticIdentity({}),
    });
    diagnostics.push(current);
    const exported = await current.export(fields);
    const saved = JSON.parse(
      await readFile(exported.path, "utf8"),
    ) as DiagnosticReport & AppUiFields;
    expect(saved.identity).toEqual(resolveDiagnosticIdentity({}));
    expect(saved.app_ui_events[2]?.identity).toEqual(identity);
    expect(saved.app_ui_events[0]).not.toHaveProperty("identity");
    expectNoPrivateValues(saved);
  });
  it("treats a missing journal in a private log directory as empty evidence", async () => {
    expect(await readAppUiJournal(await fixture())).toEqual({
      app_ui_events: [],
      app_ui_coverage: {
        available: true,
        malformed_records: 0,
        history_truncated: false,
      },
    });
  });

  it("projects only the app event DTO and never returns private or arbitrary fields", async () => {
    const root = await fixture();
    const path = await journal(root, [recordWithPrivateExtras()]);
    const before = await readFile(path, "utf8");
    const result = await readAppUiJournal(root);
    expect(result.app_ui_events).toEqual([event()]);
    expect(Object.keys(result.app_ui_events[0]!)).toEqual([
      "schema_version",
      "at",
      "session_id",
      "event",
      "code",
      "command",
    ]);
    expectNoPrivateValues(result);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("retains valid records around invalid JSON and an incomplete trailing write", async () => {
    const root = await fixture();
    const source = `${JSON.stringify(event(0))}\n{invalid json}\n${JSON.stringify(event(1))}\n{"schema_version":1,"at":`;
    const path = join(root, "ui-events.jsonl");
    await writeFile(path, source, { mode: 0o600 });
    const result = await readAppUiJournal(root);
    expect(result.app_ui_events).toEqual([event(0), event(1)]);
    expect(result.app_ui_coverage).toEqual({
      available: true,
      malformed_records: 2,
      history_truncated: false,
    });
    expect(await readFile(path, "utf8")).toBe(source);
  });

  it.each([
    ["null", null],
    ["array", []],
    ["unknown schema", { ...event(), schema_version: 2 }],
    ["invalid date", { ...event(), at: "2026-99-99T25:99:99Z" }],
    ["private path in date", { ...event(), at: privateValues[2] }],
    ["invalid session", { ...event(), session_id: "private-session-token" }],
    ["noncanonical session", { ...event(), session_id: "-".repeat(36) }],
    [
      "invalid UUID variant",
      { ...event(), session_id: "11111111-1111-4111-1111-111111111111" },
    ],
    [
      "zero UUID version",
      { ...event(), session_id: "11111111-1111-0111-8111-111111111111" },
    ],
    ["unknown event", { ...event(), event: "raw_exception" }],
    ["unknown command", { ...event(), command: "run-shell" }],
    ["URL in code", { ...event(), code: privateValues[0] }],
    ["oversize line", { ...event(), raw_error: "x".repeat(1024) }],
  ])(
    "rejects %s while preserving subsequent safe records",
    async (_label, invalid) => {
      const root = await fixture();
      await journal(root, [invalid, event(1)]);
      const result = await readAppUiJournal(root);
      expect(result.app_ui_events).toEqual([event(1)]);
      expect(result.app_ui_coverage.malformed_records).toBe(1);
      expectNoPrivateValues(result);
    },
  );

  it("reads the archive before the active file and returns the last 40 events across both", async () => {
    const root = await fixture();
    const records = Array.from({ length: 50 }, (_, index) => event(index));
    await journal(root, records.slice(0, 25), "ui-events.jsonl.1");
    await journal(root, records.slice(25));
    const result = await readAppUiJournal(root);
    expect(result.app_ui_events).toEqual(records.slice(-40));
    expect(result.app_ui_coverage).toEqual({
      available: true,
      malformed_records: 0,
      history_truncated: true,
    });
  });

  it("normalizes unknown uppercase codes instead of exporting their text", async () => {
    const root = await fixture();
    const token = "PRIVATE_SECRET_TOKEN";
    await journal(root, [{ ...event(), code: token }]);
    const result = await readAppUiJournal(root);
    expect(result.app_ui_events).toEqual([
      { ...event(), code: "UNKNOWN_ERROR" },
    ]);
    expect(result.app_ui_coverage.malformed_records).toBe(0);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("retains safe native playback and sign-in failures while discarding private exception fields", async () => {
    const root = await fixture(),
      codes = [
        "CACHE_PIN_UNAVAILABLE",
        "DESKTOP_PLAYBACK_START_FAILED",
        "DESKTOP_AUDIO_PLAYBACK_FAILED",
        "GOOGLE_SIGN_IN_TIMEOUT",
        "AUTH_SIGN_IN_FAILED",
      ];
    const path = await journal(
      root,
      codes.map((code, index) => ({ ...recordWithPrivateExtras(index), code })),
    );
    const before = await readFile(path),
      fields = await readAppUiJournal(root);
    expect(fields.app_ui_events.map((value) => value.code)).toEqual(codes);
    expectNoPrivateValues(fields);
    expect(await readFile(path)).toEqual(before);
  });

  it("uses the same code allowlist as the native app writer", async () => {
    const root = await fixture();
    const swift = await readFile(
      join(import.meta.dirname, "../macos/UIJournal.swift"),
      "utf8",
    );
    const codeBlock = swift.match(
      /private static let codes: Set<String> = \[([\s\S]*?)\n\s*\]/,
    )?.[1];
    expect(codeBlock).toBeDefined();
    const codes = [...codeBlock!.matchAll(/"([A-Z_]+)"/g)].map(
      (match) => match[1]!,
    );
    expect(codes.length).toBeGreaterThan(50);
    // Separate calls avoid the reader's deliberate last-40 projection.
    for (let offset = 0; offset < codes.length; offset += 40) {
      const group = codes.slice(offset, offset + 40);
      await journal(
        root,
        group.map((code, index) => ({ ...event(index), code })),
      );
      const result = await readAppUiJournal(root);
      expect(result.app_ui_events.map((value) => value.code)).toEqual(group);
    }
  });

  it("reports archive rotation even when fewer than 40 records remain", async () => {
    const root = await fixture();
    await journal(root, [event(0)], "ui-events.jsonl.1");
    await journal(root, [event(1)]);
    const result = await readAppUiJournal(root);
    expect(result.app_ui_events).toEqual([event(0), event(1)]);
    expect(result.app_ui_coverage.history_truncated).toBe(true);
  });

  it("bounds an unrotated file to its last 40 events and marks omitted history", async () => {
    const root = await fixture();
    const records = Array.from({ length: 43 }, (_, index) => event(index));
    await journal(root, records);
    const result = await readAppUiJournal(root);
    expect(result.app_ui_events).toEqual(records.slice(3));
    expect(result.app_ui_coverage.history_truncated).toBe(true);
  });
});

describe("native app UI journal unsafe storage", () => {
  it("rejects a symlinked log directory even when its target files are private", async () => {
    const root = await fixture();
    const targetRoot = await fixture();
    await journal(targetRoot, [event()]);
    const linked = join(root, "logs");
    await symlink(targetRoot, linked);
    const result = await readAppUiJournal(linked);
    expect(result.app_ui_events).toEqual([]);
    expect(result.app_ui_coverage.available).toBe(false);
  });

  it("rejects a public log directory without repairing its permissions", async () => {
    const root = await fixture();
    await journal(root, [event()]);
    await chmod(root, 0o755);
    const result = await readAppUiJournal(root);
    expect(result.app_ui_events).toEqual([]);
    expect(result.app_ui_coverage.available).toBe(false);
    expect((await lstat(root)).mode & 0o777).toBe(0o755);
  });

  it("rejects a log directory owned by another user", async () => {
    const root = await fixture();
    await journal(root, [event()]);
    const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    const result = await readAppUiJournal(root);
    expect(result.app_ui_events).toEqual([]);
    expect(result.app_ui_coverage.available).toBe(false);
  });

  it("rejects a journal owned by another user after validating the directory owner", async () => {
    const root = await fixture();
    await journal(root, [event()]);
    const uid = process.getuid!();
    vi.spyOn(process, "getuid")
      .mockReturnValueOnce(uid)
      .mockReturnValue(uid + 1);
    const result = await readAppUiJournal(root);
    expect(result.app_ui_events).toEqual([]);
    expect(result.app_ui_coverage.available).toBe(false);
  });

  it("rejects growth beyond the quota after the descriptor's initial stat", async () => {
    const root = await fixture();
    const path = await journal(root, [event()]);
    const realOpen = vi.mocked(fs.open).getMockImplementation()!;
    let closed = false;
    vi.mocked(fs.open).mockImplementation(async (candidate, flags, mode) => {
      const handle = await realOpen(candidate, flags, mode);
      if (candidate === path) {
        const stat = handle.stat.bind(handle);
        let initial = true;
        Object.defineProperty(handle, "stat", {
          value: async () => {
            const info = await stat();
            if (initial) {
              initial = false;
              await appendFile(path, "x".repeat(512 * 1024));
            }
            return info;
          },
        });
        const close = handle.close.bind(handle);
        Object.defineProperty(handle, "close", {
          value: async () => {
            closed = true;
            await close();
          },
        });
      }
      return handle;
    });
    const result = await readAppUiJournal(root);
    expect(result.app_ui_events).toEqual([]);
    expect(result.app_ui_coverage.available).toBe(false);
    expect(closed).toBe(true);
  });
  it.each(["ui-events.jsonl.1", "ui-events.jsonl"])(
    "rejects symlinked %s without returning target records",
    async (name) => {
      const root = await fixture();
      const targetRoot = await fixture();
      const target = await journal(
        targetRoot,
        [recordWithPrivateExtras()],
        "target.jsonl",
      );
      const before = await readFile(target, "utf8");
      await symlink(target, join(root, name));
      const result = await readAppUiJournal(root);
      expect(result.app_ui_events).toEqual([]);
      expect(result.app_ui_coverage.available).toBe(false);
      expectNoPrivateValues(result);
      expect(await readFile(target, "utf8")).toBe(before);
    },
  );

  it("rejects multiply linked files without deleting or changing either link", async () => {
    const root = await fixture();
    const target = await journal(
      root,
      [recordWithPrivateExtras()],
      "target.jsonl",
    );
    const path = join(root, "ui-events.jsonl");
    await link(target, path);
    const before = await readFile(target, "utf8");
    const result = await readAppUiJournal(root);
    expect(result.app_ui_events).toEqual([]);
    expect(result.app_ui_coverage.available).toBe(false);
    expect((await lstat(path)).nlink).toBe(2);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await readFile(target, "utf8")).toBe(before);
  });

  it.each([0o640, 0o604, 0o644])(
    "rejects files with nonprivate mode %s",
    async (mode) => {
      const root = await fixture();
      const path = await journal(root, [recordWithPrivateExtras()]);
      await chmod(path, mode);
      const result = await readAppUiJournal(root);
      expect(result.app_ui_events).toEqual([]);
      expect(result.app_ui_coverage.available).toBe(false);
      expect((await lstat(path)).mode & 0o777).toBe(mode);
    },
  );

  it("rejects a directory occupying the journal filename", async () => {
    const root = await fixture();
    await mkdir(join(root, "ui-events.jsonl"), { mode: 0o700 });
    const result = await readAppUiJournal(root);
    expect(result.app_ui_events).toEqual([]);
    expect(result.app_ui_coverage.available).toBe(false);
  });

  it("rejects an oversized journal before treating it as event history", async () => {
    const root = await fixture();
    await writeFile(join(root, "ui-events.jsonl"), "x".repeat(512 * 1024 + 1), {
      mode: 0o600,
    });
    const result = await readAppUiJournal(root);
    expect(result.app_ui_events).toEqual([]);
    expect(result.app_ui_coverage).toEqual({
      available: false,
      malformed_records: 0,
      history_truncated: false,
    });
  });

  it("preserves safe archived evidence when the active file is unsafe", async () => {
    const root = await fixture();
    await journal(root, [event(0)], "ui-events.jsonl.1");
    const active = await journal(root, [recordWithPrivateExtras(1)]);
    await chmod(active, 0o644);
    const result = await readAppUiJournal(root);
    expect(result.app_ui_events).toEqual([event(0)]);
    expect(result.app_ui_coverage.available).toBe(false);
    expect(result.app_ui_coverage.history_truncated).toBe(true);
    expectNoPrivateValues(result);
  });
});

describe("native app diagnostic export integration", () => {
  it("adds projected UI history and setup diagnostics only to the requested export", async () => {
    const root = await fixture();
    const native = writer(root);
    native.record({
      component: "companion",
      severity: "info",
      event: "companion_started",
    });
    native.record({
      component: "extension",
      severity: "error",
      event: "diagnostic_error",
      code: "COMPANION_DISCONNECTED",
      metrics: { source_url: privateValues[0] },
    });
    const setup = writer(join(root, "setup"));
    setup.record({
      component: "companion",
      severity: "info",
      event: "stage_completed",
      metrics: {
        stage: "model-download",
        duration_ms: 250,
        raw_token: privateValues[1],
      },
    });
    setup.record({
      component: "companion",
      severity: "error",
      event: "diagnostic_error",
      code: "MODEL_CHECKSUM_INVALID",
      metrics: { raw_error: privateValues[3] },
    });
    await journal(root, [recordWithPrivateExtras()]);
    const nativeBefore = await readFile(join(root, "events.jsonl"), "utf8");
    const setupBefore = await readFile(
      join(root, "setup/events.jsonl"),
      "utf8",
    );
    const nativeSnapshot = native.snapshot();
    const setupDiagnostics = setup.snapshot();
    const ui = await readAppUiJournal(root);
    const reader = writer(root, true);
    const base = await reader.export();
    const extended = await reader.export({
      ...ui,
      app_setup_diagnostics: setupDiagnostics,
    });
    const report = JSON.parse(
      await readFile(extended.path, "utf8"),
    ) as DiagnosticReport &
      AppUiFields & { app_setup_diagnostics: DiagnosticReport };
    expect(report).toEqual(extended.report);
    expect(report.app_ui_events).toEqual([event()]);
    expect(report.app_ui_coverage).toEqual(ui.app_ui_coverage);
    expect(report.app_setup_diagnostics).toEqual(setupDiagnostics);
    expect(report.app_setup_diagnostics.recent_errors[0]?.code).toBe(
      "MODEL_CHECKSUM_INVALID",
    );
    const {
      app_ui_events: _events,
      app_ui_coverage: _coverage,
      app_setup_diagnostics: _setup,
      ...nativeFields
    } = report;
    expect(nativeFields).toEqual(base.report);
    expect(base.report).not.toHaveProperty("app_ui_events");
    expect(base.report).not.toHaveProperty("app_setup_diagnostics");
    expect(await readFile(base.path, "utf8")).toBe(
      `${JSON.stringify(base.report, null, 2)}\n`,
    );
    expect(native.snapshot()).toEqual(nativeSnapshot);
    expect(await readFile(join(root, "events.jsonl"), "utf8")).toBe(
      nativeBefore,
    );
    expect(await readFile(join(root, "setup/events.jsonl"), "utf8")).toBe(
      setupBefore,
    );
    expectNoPrivateValues(report);
    expect((await lstat(extended.path)).mode & 0o777).toBe(0o600);
    expect(extended.path).not.toBe(base.path);
  });
});
