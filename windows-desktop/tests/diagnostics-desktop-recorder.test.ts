import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  DesktopDiagnosticRecorder,
  type DiagnosticOwner,
} from "../src/main/diagnostics/desktop-recorder.js";
import { WindowsDiagnosticJournal } from "../src/main/diagnostics/journal.js";
import {
  diagnosticFixture,
  diagnosticIdentity,
} from "./diagnostics-fixtures.js";
import { projectDiagnosticInput } from "../src/main/diagnostics/projection.js";
import { chromeDiagnosticSummary } from "../src/main/diagnostics/browser-report.js";
import type { DesktopSnapshot } from "../src/shared/contracts.js";
import type { AccountView } from "../src/shared/account-contracts.js";
import type { PersonalJobView } from "../src/shared/personal-contracts.js";
vi.mock("node:path", async () => {
  const path = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...path,
    win32: {
      ...path.win32,
      join: (...parts: string[]) =>
        path.join(...parts.flatMap((p) => p.split("\\"))),
    },
  };
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
  const files = await diagnosticFixture(),
    journal = new WindowsDiagnosticJournal(files.host, diagnosticIdentity);
  let now = 100,
    owner: DiagnosticOwner = {
      personal: {},
      personalOwnerId: randomUUID(),
      accountGeneration: "private-generation-A",
      window: "private-window-A",
    };
  const recorder = new DesktopDiagnosticRecorder({
    owner: () => ({ ...owner }),
    record: (value) => journal.record(value),
    memory: () => ({ rss: 1234, heapUsed: 567 }),
    now: () => now,
  });
  cleanups.push(async () => {
    await journal.close();
    await rm(files.root, { recursive: true, force: true });
  });
  return {
    ...files,
    journal,
    recorder,
    setTime: (value: number) => {
      now = value;
    },
    owner: () => owner,
    setOwner: (value: Partial<DiagnosticOwner>) => {
      owner = { ...owner, ...value };
    },
  };
}
function job(
  ownerId: string,
  patch: Partial<PersonalJobView> = {},
): PersonalJobView {
  return {
    id: randomUUID(),
    ownerId,
    state: "preparing",
    stage: "separation",
    progress: null,
    name: "private-media-title",
    error: null,
    original: null,
    vocals: null,
    ...patch,
  };
}
const personal = (jobs: PersonalJobView[]) => ({
  personal: {
    jobs,
    connected: true,
    busy: jobs.some((j) => j.state === "preparing"),
    error: null,
  },
});
function account(patch: Partial<AccountView> = {}): AccountView {
  return {
    state: "signed-in",
    busy: false,
    online: true,
    googleSignInActive: false,
    user: {
      id: "private-user-id",
      displayName: "private-name",
      email: "private@example.invalid",
      emailVerified: true,
      providers: ["google.com"],
      workerRegistrationAllowed: false,
    },
    devices: [],
    nextDeviceCursor: null,
    recovery: null,
    minimumBuild: null,
    access: { allowed: true, reason: null },
    verificationCooldownSeconds: 0,
    resetCooldownSeconds: 0,
    errorCode: null,
    noticeCode: null,
    ...patch,
  };
}
it("receives actual account/realtime/Library/sync/Fleet/Advanced states without their private data", async () => {
  const f = await fixture();
  const live: Partial<DesktopSnapshot> = {
    accountDetails: account(),
    usage: {
      connection: "live",
      authenticated: true,
      libraryReady: true,
      usageState: "current",
      usage: null,
      policyState: "unavailable",
      policy: null,
      errorCode: null,
    },
    library: {
      revision: 1,
      state: "ready",
      accountState: "live",
      errorCode: null,
      query: {
        search: "private-query",
        filter: "all",
        sort: "newest",
        mostPlayedOnly: false,
        starredOnly: false,
      },
      tracks: [],
      visibleIds: [],
      total: 0,
      nextCursor: null,
    },
    outbox: { authenticated: true, busy: true, errorCode: null, items: [] },
    fleet: {
      state: "registered",
      eligibility: "ready",
      busy: false,
      machineId: "private-machine",
      label: "private-label",
      intent: "running",
      connected: true,
      backendState: "active",
      activeAttempts: 0,
      claimsAllowed: true,
      errorCode: null,
    },
    fleetAdvanced: {
      phase: "loading",
      machineId: "private-machine",
      section: "status",
      data: { credential: "private-token", path: "C:\\private\\media.wav" },
      confirmation: null,
      problem: null,
      cancellable: true,
    },
  };
  await f.recorder.receive({}, live);
  const failures: Partial<DesktopSnapshot> = {
    accountDetails: account({
      online: false,
      errorCode: "SECRET_BEARER_UPPERCASE",
    }),
    usage: {
      ...live.usage!,
      connection: "reconnecting",
      errorCode: "private-token",
    },
    library: {
      ...live.library!,
      state: "error",
      accountState: "disconnected",
      errorCode: "private-path",
    },
    outbox: { ...live.outbox!, busy: false, errorCode: "private-token" },
    fleet: {
      ...live.fleet!,
      state: "unavailable",
      errorCode: "private-machine-secret",
    },
    fleetAdvanced: {
      ...live.fleetAdvanced!,
      phase: "error",
      problem: "private-stderr",
    },
    worker: { state: "error" },
  };
  await f.recorder.receive(live, failures);
  await f.recorder.receive(failures, failures);
  const report = await f.journal.snapshot(true);
  expect(report.counts).toMatchObject({
    "account.completed": 2,
    "account.failed": 2,
    "library.completed": 1,
    "library.progress": 1,
    "library.failed": 2,
    "worker.failed": 3,
  });
  expect(report.recentErrors.map((e) => e.code)).toEqual([
    "ACCOUNT_UNAVAILABLE",
    "REALTIME_DISCONNECTED",
    "LIBRARY_UNAVAILABLE",
    "OUTBOX_SAVE_FAILED",
    "FLEET_UNAVAILABLE",
    "FLEET_UNAVAILABLE",
    "ADVANCED_OPERATION_FAILED",
  ]);
  const bytes = await readFile(f.path("diagnostics\\events-0.jsonl"), "utf8");
  for (const secret of ["private-", "private@", "SECRET_BEARER", "C:\\private"])
    expect(bytes).not.toContain(secret);
  expect(report.coverage.rejectedFields).toBe(0);
  expect(chromeDiagnosticSummary(report).counts).toEqual(report.counts);
});
it("preserves all six actual Main reason codes while arbitrary codes remain generic", () => {
  for (const code of [
    "DESKTOP_STARTED",
    "PREPARATION_STATE",
    "UPDATE_STATE",
    "PERSONAL_STATE",
    "ACCOUNT_SCOPE_TRANSITION_FAILED",
    "ACCOUNT_AUTHORITY_RETIREMENT_FAILED",
  ]) {
    const projected = projectDiagnosticInput({
      subsystem: "lifecycle",
      event: "progress",
      severity: "info",
      code,
      phase: "validation",
      metrics: {},
    });
    expect(projected).toMatchObject({ rejected: 0, input: { code } });
  }
  expect(
    projectDiagnosticInput({
      subsystem: "account",
      event: "failed",
      code: "SECRET_PASSWORD_A",
    }).input.code,
  ).toBe("UNKNOWN_ERROR");
});
it("records actual Setup/update transitions and retains their earlier safe failures after success", async () => {
  const f = await fixture();
  const preparing: Partial<DesktopSnapshot> = {
    preparation: {
      state: "preparing",
      stage: "model",
      percent: null,
      completedBytes: null,
      totalBytes: null,
      requiredBytes: null,
      availableBytes: null,
      errorCode: null,
      browser: "unknown",
    },
    consumerUpdate: {
      phase: "downloading",
      available: null,
      required: false,
      automaticDiscovery: false,
      problem: null,
    },
  };
  await f.recorder.receive({}, preparing);
  const failed: Partial<DesktopSnapshot> = {
    preparation: {
      ...preparing.preparation!,
      state: "error",
      errorCode: "LOW_DISK",
    },
    consumerUpdate: {
      ...preparing.consumerUpdate!,
      phase: "blocked",
      problem: "UPDATE_RECOVERY_REQUIRED",
    },
  };
  await f.recorder.receive(preparing, failed);
  const completed: Partial<DesktopSnapshot> = {
    preparation: { ...preparing.preparation!, state: "ready", stage: null },
    consumerUpdate: { ...preparing.consumerUpdate!, phase: "complete" },
  };
  await f.recorder.receive(failed, completed);
  const report = await f.journal.snapshot(true);
  expect(report.counts).toMatchObject({
    "setup.progress": 1,
    "setup.failed": 1,
    "setup.completed": 1,
    "update.progress": 1,
    "update.failed": 1,
    "update.completed": 1,
  });
  expect(report.recentErrors.map((event) => event.code)).toEqual([
    "PREPARATION_FAILED",
    "UPDATE_RECOVERY_REQUIRED",
  ]);
  expect(
    report.recentEvents
      .filter((event) => event.event === "completed")
      .map((event) => event.code),
  ).toEqual(["PREPARATION_STATE", "UPDATE_STATE"]);
  expect(report.coverage.rejectedFields).toBe(0);
});
it("measures observed monotonic exited stages, deduplicates progress and preserves cancellation through public projection", async () => {
  const f = await fixture(),
    first = job(f.owner().personalOwnerId!);
  await f.recorder.receive({}, personal([first]));
  f.setTime(400);
  await f.recorder.receive(
    personal([first]),
    personal([{ ...first, progress: 0.5 }]),
  );
  f.setTime(1000);
  const encoding = { ...first, stage: "encoding" as const };
  await f.recorder.receive(personal([first]), personal([encoding]));
  f.setTime(1600);
  const cancelled = {
    ...encoding,
    state: "cancelled" as const,
    error: "CANCELLED" as const,
  };
  await f.recorder.receive(personal([encoding]), personal([cancelled]));
  f.setTime(1800);
  await f.recorder.receive(personal([cancelled]), personal([cancelled]));
  const report = await f.journal.snapshot(true);
  expect(report.jobs[0]).toMatchObject({
    job: first.id,
    state: "cancelled",
    stagesMilliseconds: { separation: 900, encode: 600 },
  });
  expect(report.counts["personal.cancelled"]).toBe(1);
  expect(report.counts["personal.completed"]).toBeUndefined();
  expect(report.jobs[0]?.incomplete).toBe(true);
  expect(chromeDiagnosticSummary(report).jobs[0]).toMatchObject({
    state: "cancelled",
    stagesMilliseconds: { separation: 900, encode: 600 },
  });
});
it("fences old controller/window/account generations without attributing old elapsed time to replacements", async () => {
  const f = await fixture(),
    first = job(f.owner().personalOwnerId!);
  await f.recorder.receive({}, personal([first]));
  f.setTime(9000);
  f.setOwner({
    personal: {},
    personalOwnerId: randomUUID(),
    accountGeneration: "private-generation-B",
    window: "private-window-B",
  });
  await f.recorder.receive(
    personal([first]),
    personal([{ ...first, state: "ready" }]),
  );
  const next = job(f.owner().personalOwnerId!);
  await f.recorder.receive({}, personal([next]));
  f.setTime(9200);
  await f.recorder.receive(
    personal([next]),
    personal([{ ...next, stage: "encoding" }]),
  );
  const report = await f.journal.snapshot(true);
  expect(
    report.jobs.find((j) => j.job === first.id)?.stagesMilliseconds,
  ).toEqual({});
  expect(report.jobs.find((j) => j.job === first.id)?.state).toBe("active");
  expect(
    report.jobs.find((j) => j.job === next.id)?.stagesMilliseconds,
  ).toEqual({ separation: 200 });
  f.setOwner({ accountGeneration: "private-generation-C" });
  f.setTime(9300);
  await f.recorder.receive(
    personal([next]),
    personal([{ ...next, stage: "encoding" }]),
  );
  f.setTime(9400);
  await f.recorder.receive(
    personal([next]),
    personal([{ ...next, stage: "encoding", state: "ready" }]),
  );
  expect(
    (await f.journal.snapshot()).jobs.find((j) => j.job === next.id)
      ?.stagesMilliseconds,
  ).toEqual({ separation: 200, encode: 100 });
});
it.each<Partial<DiagnosticOwner>>([
  { personal: {} },
  { window: "replacement-window" },
  { accountGeneration: "replacement-account-generation" },
])("independently fences a replaced authority %j", async (replacement) => {
  const f = await fixture(),
    first = job(f.owner().personalOwnerId!);
  await f.recorder.receive({}, personal([first]));
  f.setTime(4000);
  f.setOwner(replacement);
  const next = { ...first, stage: "encoding" as const };
  await f.recorder.receive(personal([first]), personal([next]));
  f.setTime(4400);
  await f.recorder.receive(
    personal([next]),
    personal([{ ...next, state: "ready" }]),
  );
  expect((await f.journal.snapshot()).jobs[0]?.stagesMilliseconds).toEqual({
    encode: 400,
  });
});
it("never invents timings for recovered terminal jobs, clock resets or evicted observations", async () => {
  const f = await fixture(),
    recovered = job(f.owner().personalOwnerId!, { state: "ready" });
  await f.recorder.receive({}, personal([recovered]));
  const first = job(f.owner().personalOwnerId!);
  await f.recorder.receive({}, personal([first]));
  f.setTime(50);
  await f.recorder.receive(
    personal([first]),
    personal([{ ...first, stage: "encoding" }]),
  );
  const many = Array.from({ length: 17 }, () =>
    job(f.owner().personalOwnerId!),
  );
  await f.recorder.receive({}, personal(many));
  f.setTime(900);
  await f.recorder.receive({}, personal([{ ...first, state: "ready" }]));
  const report = await f.journal.snapshot(true);
  expect(
    report.jobs.find((j) => j.job === recovered.id)?.stagesMilliseconds,
  ).toEqual({});
  expect(
    report.jobs.find((j) => j.job === first.id)?.stagesMilliseconds,
  ).toEqual({});
  expect(
    report.jobs.filter((j) => many.some((v) => v.id === j.job)),
  ).toHaveLength(16);
});
it.each([Number.NaN, 100 + 25 * 60 * 60 * 1000])(
  "omits invalid or unobserved long stage intervals %s",
  async (time) => {
    const f = await fixture(),
      first = job(f.owner().personalOwnerId!);
    await f.recorder.receive({}, personal([first]));
    f.setTime(time);
    await f.recorder.receive(
      personal([first]),
      personal([{ ...first, state: "ready" }]),
    );
    expect((await f.journal.snapshot()).jobs[0]?.stagesMilliseconds).toEqual(
      {},
    );
  },
);
it("awaits accepted writes but isolates sink failures and blocks reentrant old-owner append", async () => {
  let owner: DiagnosticOwner = {
    personal: null,
    personalOwnerId: null,
    accountGeneration: "A",
    window: "A",
  };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    inputs: unknown[] = [];
  const recorder = new DesktopDiagnosticRecorder({
    owner: () => owner,
    memory: () => ({ rss: 1, heapUsed: 2 }),
    record: (input) => {
      inputs.push(input);
      owner = { ...owner, accountGeneration: "B" };
      return held;
    },
  });
  let done = false;
  const work = recorder
    .receive({}, { accountDetails: account(), worker: { state: "error" } })
    .then(() => {
      done = true;
    });
  await Promise.resolve();
  expect(done).toBe(false);
  expect(inputs).toHaveLength(1);
  release();
  await work;
  expect(done).toBe(true);
  const broken = new DesktopDiagnosticRecorder({
    owner: () => owner,
    memory: () => ({ rss: 0, heapUsed: 0 }),
    record: () => {
      throw new Error("private-sink-failure");
    },
  });
  await expect(
    broken.receive({}, { worker: { state: "error" } }),
  ).resolves.toBeUndefined();
});
