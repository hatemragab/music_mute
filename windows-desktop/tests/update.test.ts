import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalConsumerUpdate,
  consumerUpdateIdentity,
  consumerUpdateVersions,
  verifyConsumerUpdate,
  consumerUpdateSourceDescriptor,
  type ConsumerUpdateTrust,
} from "../src/main/update/metadata.js";
import {
  ConsumerUpdateController,
  parseConsumerUpdateState,
  type ConsumerUpdatePorts,
  type ConsumerUpdateState,
  consumerUpdateJournalSource,
} from "../src/main/update/controller.js";
import {
  parseConsumerUpdateCommand,
  type ConsumerUpdateMetadata,
  type ConsumerVersionSet,
} from "../src/shared/update-contracts.js";
const keys = generateKeyPairSync("ed25519"),
  now = new Date("2026-10-09T10:00:00.000Z");
const trust: ConsumerUpdateTrust = {
  feed: "https://updates.example.invalid/stable.json",
  allowedOrigins: ["https://updates.example.invalid"],
  publicKeys: {
    fixture: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  },
  publisherSha256: "9".repeat(64),
};
const metadata: ConsumerUpdateMetadata = {
  schemaVersion: 1,
  installationProfile: "windows-user",
  platform: "windows-amd64",
  channel: "stable",
  sequence: 2,
  publishedAt: "2026-10-09T09:00:00.000Z",
  expiresAt: "2026-10-10T10:00:00.000Z",
  dataSchema: 1,
  publisherSha256: trust.publisherSha256,
  app: {
    version: "2.0.0",
    payloadSha256: "a".repeat(64),
    artifact: {
      filename: "app.exe",
      url: "https://updates.example.invalid/app.exe",
      bytes: 64,
      sha256: "b".repeat(64),
      contentType: "application/x-msdownload",
    },
  },
  runtime: {
    version: "2.0.0",
    minimumAppVersion: "2.0.0",
    artifact: {
      filename: "runtime.zip",
      url: "https://updates.example.invalid/runtime.zip",
      bytes: 128,
      sha256: "c".repeat(64),
      contentType: "application/zip",
    },
  },
  model: {
    version: "2.0.0",
    minimumRuntimeVersion: "2.0.0",
    artifact: {
      filename: "model.onnx",
      url: "https://updates.example.invalid/model.onnx",
      bytes: 256,
      sha256: "d".repeat(64),
      contentType: "application/octet-stream",
    },
  },
  required: {
    minimumAppVersion: "1.0.0",
    minimumRuntimeVersion: "1.0.0",
    minimumModelVersion: "1.0.0",
  },
};
const signed = (value: ConsumerUpdateMetadata = metadata) => ({
  keyId: "fixture",
  metadata: value,
  signature: sign(
    null,
    Buffer.from(canonicalConsumerUpdate(value)),
    keys.privateKey,
  ).toString("base64url"),
});
const previous: ConsumerVersionSet = {
  app: { version: "1.0.0", sha256: "1".repeat(64) },
  runtime: { version: "1.0.0", sha256: "2".repeat(64) },
  model: { version: "1.0.0", sha256: "3".repeat(64) },
};
function fixture() {
  let state: ConsumerUpdateState | null = null;
  const phases: string[] = [];
  const release = vi.fn(async () => {}),
    commit = vi.fn(async () => {}),
    lockRelease = vi.fn(async () => {}),
    installer = { release, commit };
  const ports: ConsumerUpdatePorts = {
    trust,
    current: vi.fn(async () => previous),
    candidate: vi.fn(async () => signed()),
    store: {
      read: async () => structuredClone(state),
      write: vi.fn(async (next) => {
        phases.push(next.journal?.phase ?? "decision");
        state = structuredClone(next);
      }),
    },
    lock: vi.fn(async () => ({ release: lockRelease })),
    stage: vi.fn(async () => {}),
    verifyStage: vi.fn(async () => {}),
    preserveConsumers: vi.fn(async () => {}),
    maintenance: vi.fn(async () => installer),
    backup: vi.fn(async () => {}),
    restartRequired: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    health: vi.fn(async () => true),
    rollback: vi.fn(async () => {}),
    verifyPrevious: vi.fn(async () => true),
    cleanup: vi.fn(async () => {}),
    now: () => now,
  };
  return {
    ports,
    controller: new ConsumerUpdateController(ports),
    release,
    commit,
    lockRelease,
    phases,
    state: () => state,
    setState: (value: ConsumerUpdateState) => {
      state = value;
    },
  };
}
describe("separate approved consumer catalog and reviewed force plan", () => {
  const catalogMetadata = (): ConsumerUpdateMetadata => ({
    ...structuredClone(metadata),
    app: {
      ...metadata.app,
      version: previous.app.version,
      payloadSha256: previous.app.sha256,
    },
    runtime: { ...metadata.runtime, minimumAppVersion: previous.app.version },
  });
  const configure = (f: ReturnType<typeof fixture>) => {
    const catalogTrust = {
      ...trust,
      feed: "https://updates.example.invalid/worker-catalog.json",
    };
    f.ports.sourceTrust = vi.fn(async (source) =>
      source === "catalog" ? catalogTrust : trust,
    );
    f.ports.candidate = vi.fn(async (_signal, source) => {
      expect(source).toBe("catalog");
      return signed(catalogMetadata());
    });
    return catalogTrust;
  };
  it("freezes separately approved catalog trust/source in the same protected transaction with exact installed app identity", async () => {
    const f = fixture(),
      catalogTrust = configure(f);
    await f.controller.install(new AbortController().signal, "catalog");
    expect(f.state()?.journal).toMatchObject({
      source: "catalog",
      scope: "prepared",
      sourceDescriptor: consumerUpdateSourceDescriptor(catalogTrust),
    });
    expect(consumerUpdateJournalSource(f.state()!.journal!)).toBe("catalog");
    expect(f.ports.stage).toHaveBeenCalledOnce();
    expect(f.ports.activate).toHaveBeenCalledOnce();
    expect(f.state()?.journal?.previous).toEqual(previous);
  });
  it("never borrows the app channel when catalog trust is absent and refuses an app replacement or stale GPU plan before staging", async () => {
    const unavailable = fixture();
    await expect(
      unavailable.controller.check(
        new AbortController().signal,
        false,
        "catalog",
      ),
    ).rejects.toThrow("UPDATE_CATALOG_UNAVAILABLE");
    expect(unavailable.ports.candidate).not.toHaveBeenCalled();
    const differentApp = fixture();
    configure(differentApp);
    differentApp.ports.candidate = vi.fn(async () => signed());
    await expect(
      differentApp.controller.install(new AbortController().signal, "catalog"),
    ).rejects.toThrow("UPDATE_CATALOG_APP_MISMATCH");
    expect(differentApp.ports.stage).not.toHaveBeenCalled();
    const unqualified = fixture();
    configure(unqualified);
    unqualified.ports.operationScope = async () => "app-only";
    await expect(
      unqualified.controller.install(new AbortController().signal, "catalog"),
    ).rejects.toThrow("UPDATE_PREPARE_REQUIRED");
    expect(unqualified.ports.stage).not.toHaveBeenCalled();
    expect(unqualified.lockRelease).toHaveBeenCalledOnce();
  });
  it("recovers the frozen catalog source without fetching and blocks changed approved descriptor before any mutation", async () => {
    const f = fixture();
    configure(f);
    f.ports.health = vi.fn(async () => false);
    f.ports.rollback = vi.fn(async () => {
      throw new Error("UPDATE_ROLLBACK_UNAVAILABLE");
    });
    await expect(
      f.controller.install(new AbortController().signal, "catalog"),
    ).rejects.toThrow();
    expect(f.state()?.journal?.source).toBe("catalog");
    const calls = vi.mocked(f.ports.candidate).mock.calls.length;
    f.ports.sourceTrust = vi.fn(async () => ({
      ...trust,
      feed: "https://updates.example.invalid/replaced.json",
    }));
    vi.mocked(f.ports.lock).mockClear();
    f.lockRelease.mockClear();
    vi.mocked(f.ports.activate).mockClear();
    await expect(
      f.controller.recover(new AbortController().signal),
    ).rejects.toThrow("UPDATE_SOURCE_CHANGED");
    expect(f.ports.candidate).toHaveBeenCalledTimes(calls);
    expect(f.ports.activate).not.toHaveBeenCalled();
    expect(f.lockRelease).toHaveBeenCalledOnce();
  });
  it("retains reviewed exact machine/state force authority in the updater's own immutable transaction", async () => {
    const f = fixture(),
      transaction = randomUUID(),
      review = {
        force: true,
        transaction,
        machineId: randomUUID(),
        authority: "f".repeat(64),
        expectedRevision: 7,
      };
    await f.controller.install(new AbortController().signal, "app", review);
    expect(f.state()?.journal).toMatchObject({
      transaction,
      fleetForce: {
        machineId: review.machineId,
        authority: review.authority,
        expectedRevision: 7,
      },
      source: "app",
    });
    const invalid = fixture();
    await expect(
      invalid.controller.install(new AbortController().signal, "app", {
        ...review,
        expectedRevision: 0,
      }),
    ).rejects.toThrow("UPDATE_STATE_INVALID");
    expect(invalid.lockRelease).toHaveBeenCalledOnce();
    expect(invalid.ports.stage).not.toHaveBeenCalled();
  });
  it("only the authenticated distinct pre-effect force rejection terminally aborts an unchanged plan; ACK/tree uncertainty remains recoverable", async () => {
    const review = {
        force: true,
        transaction: randomUUID(),
        machineId: randomUUID(),
        authority: "f".repeat(64),
        expectedRevision: 7,
      },
      f = fixture();
    f.ports.maintenance = vi.fn(async () => {
      throw new Error("UPDATE_FORCE_CONFIRMATION_STALE");
    });
    await expect(
      f.controller.install(new AbortController().signal, "app", review),
    ).rejects.toThrow("UPDATE_FORCE_CONFIRMATION_STALE");
    expect(f.state()?.journal?.phase).toBe("rolled-back");
    expect(f.state()?.highestSequence).toBe(metadata.sequence);
    expect(f.ports.activate).not.toHaveBeenCalled();
    expect(f.ports.backup).not.toHaveBeenCalled();
    expect(f.ports.rollback).not.toHaveBeenCalled();
    const uncertain = fixture();
    uncertain.ports.maintenance = vi.fn(async () => {
      throw new Error("CHILD_SHUTDOWN_PENDING");
    });
    await expect(
      uncertain.controller.install(new AbortController().signal, "app", review),
    ).rejects.toThrow("CHILD_SHUTDOWN_PENDING");
    expect(uncertain.state()?.journal?.phase).toBe("staged");
  });
  it("admits only the exact protected Advanced updater recovery transaction/source/original owner without HTTP or mutation", async () => {
    const f = fixture(),
      review = {
        transaction: randomUUID(),
        machineId: randomUUID(),
        authority: "f".repeat(64),
      };
    f.ports.activate = vi.fn(async () => {
      throw new Error("UPDATE_INSTALLER_UNCONFIRMED");
    });
    await expect(
      f.controller.install(new AbortController().signal, "app", review),
    ).rejects.toThrow("UPDATE_INSTALLER_UNCONFIRMED");
    const candidateCalls = vi.mocked(f.ports.candidate).mock.calls.length,
      stageCalls = vi.mocked(f.ports.stage).mock.calls.length;
    expect(
      await f.controller.matchesAdvancedRecovery({ ...review, source: "app" }),
    ).toBe(true);
    for (const patch of [
      { transaction: randomUUID() },
      { machineId: randomUUID() },
      { authority: "a".repeat(64) },
      { source: "catalog" as const },
    ])
      expect(
        await f.controller.matchesAdvancedRecovery({
          ...review,
          source: "app",
          ...patch,
        }),
      ).toBe(false);
    expect(f.ports.candidate).toHaveBeenCalledTimes(candidateCalls);
    expect(f.ports.stage).toHaveBeenCalledTimes(stageCalls);
    const state = f.state()!;
    (state.journal!.signed as { signature: string }).signature = "x".repeat(86);
    f.setState(state);
    await expect(
      f.controller.matchesAdvancedRecovery({ ...review, source: "app" }),
    ).rejects.toThrow("UPDATE_SIGNATURE_INVALID");
  });
  it("retains legacy app journals but rejects missing source proof, catalog cold scope, malformed force and unknown protected fields", () => {
    const state: ConsumerUpdateState = {
      version: 1,
      automaticDiscovery: false,
      highestSequence: 0,
      observed: null,
      quarantined: [],
      journal: {
        transaction: randomUUID(),
        identity: "a".repeat(64),
        signed: signed(),
        previous,
        startedAt: now.toISOString(),
        phase: "staged",
      },
    };
    expect(
      consumerUpdateJournalSource(parseConsumerUpdateState(state).journal!),
    ).toBe("app");
    for (const patch of [
      { source: "catalog" },
      {
        source: "catalog",
        sourceDescriptor: "f".repeat(64),
        scope: "app-only",
      },
      {
        fleetForce: {
          machineId: randomUUID(),
          authority: "x",
          expectedRevision: 1,
        },
      },
      { source: "service", sourceDescriptor: "f".repeat(64) },
      { shell: "powershell" },
    ])
      expect(() =>
        parseConsumerUpdateState({
          ...state,
          journal: { ...state.journal, ...patch },
        }),
      ).toThrow("UPDATE_STATE_INVALID");
  });
});
describe("read-only updater startup recovery authority", () => {
  it("publishes pending recovery before automatic discovery without fetching, locking or preparing", async () => {
    const f = fixture();
    f.setState({
      version: 1,
      automaticDiscovery: false,
      highestSequence: 2,
      observed: null,
      quarantined: [],
      journal: {
        transaction: randomUUID(),
        identity: consumerUpdateIdentity(metadata),
        signed: signed(),
        previous,
        startedAt: now.toISOString(),
        phase: "activating",
      },
    });
    const result = await f.controller.initialize();
    expect(result).toMatchObject({
      recoveryRequired: true,
      invalidState: false,
      transaction: f.state()!.journal!.transaction,
    });
    expect(f.controller.snapshot()).toMatchObject({
      phase: "blocked",
      problem: "UPDATE_RECOVERY_REQUIRED",
      scope: "prepared",
    });
    await expect(
      f.controller.check(new AbortController().signal, true),
    ).rejects.toThrow("UPDATE_RECOVERY_REQUIRED");
    expect(f.ports.candidate).not.toHaveBeenCalled();
    expect(f.ports.lock).toHaveBeenCalledOnce();
    expect(f.ports.stage).not.toHaveBeenCalled();
    expect(f.ports.activate).not.toHaveBeenCalled();
    expect(f.ports.current).not.toHaveBeenCalled();
    expect(f.ports.store.write).not.toHaveBeenCalled();
  });
  it("corrupt protected state exposes blocked recovery instead of an idle view and never resets state", async () => {
    const f = fixture();
    f.setState({
      version: 1,
      unexpected: "private state",
    } as unknown as ConsumerUpdateState);
    expect(await f.controller.initialize()).toEqual({
      recoveryRequired: true,
      invalidState: true,
      transaction: null,
    });
    expect(f.controller.snapshot()).toMatchObject({
      phase: "blocked",
      problem: "UPDATE_STATE_INVALID",
      available: null,
    });
    expect(f.ports.candidate).not.toHaveBeenCalled();
    expect(f.ports.lock).not.toHaveBeenCalled();
    expect(f.ports.store.write).not.toHaveBeenCalled();
  });
  it("cold no-state initialization remains idle and invokes no runtime/model/installer ports", async () => {
    const f = fixture();
    expect(await f.controller.initialize()).toEqual({
      recoveryRequired: false,
      invalidState: false,
      transaction: null,
    });
    expect(f.controller.snapshot().phase).toBe("idle");
    expect(f.ports.candidate).not.toHaveBeenCalled();
    expect(f.ports.lock).not.toHaveBeenCalled();
    expect(f.ports.current).not.toHaveBeenCalled();
    expect(f.ports.maintenance).not.toHaveBeenCalled();
    expect(f.ports.store.write).not.toHaveBeenCalled();
  });
});
describe("signed consumer app/runtime/model update policy", () => {
  it("verifies independent versions, pinned publisher and immutable app payload separately from installer", () => {
    expect(verifyConsumerUpdate(signed(), trust, 1, now)).toEqual(metadata);
    expect(consumerUpdateVersions(metadata).app.sha256).toBe(
      metadata.app.payloadSha256,
    );
  });
  it.each([
    ["service profile", { installationProfile: undefined }],
    ["wrong target", { platform: "darwin-arm64" }],
    ["wrong channel", { channel: "beta" }],
    ["future schema", { dataSchema: 2 }],
    ["publisher mismatch", { publisherSha256: "8".repeat(64) }],
    ["expired metadata", { expiresAt: "2026-10-09T09:30:00.000Z" }],
  ])("rejects signed %s", (_label, patch) => {
    const changed = { ...metadata, ...patch } as ConsumerUpdateMetadata;
    expect(() => verifyConsumerUpdate(signed(changed), trust, 1, now)).toThrow(
      /UPDATE_/,
    );
  });
  it("rejects hash edits without signature, sequence rollback, unsafe URLs and incompatible component dependencies", () => {
    expect(() =>
      verifyConsumerUpdate(
        { ...signed(), metadata: { ...metadata, sequence: 3 } },
        trust,
        1,
        now,
      ),
    ).toThrow("UPDATE_SIGNATURE_INVALID");
    expect(() => verifyConsumerUpdate(signed(), trust, 3, now)).toThrow(
      "UPDATE_REPLAY",
    );
    for (const url of [
      "http://updates.example.invalid/a.zip",
      "https://foreign.example/a.zip",
      "https://user:secret@updates.example.invalid/a.zip",
      "https://updates.example.invalid/a.zip#fragment",
    ]) {
      const altered = structuredClone(metadata);
      altered.runtime.artifact.url = url;
      expect(() =>
        verifyConsumerUpdate(signed(altered), trust, 1, now),
      ).toThrow("UPDATE_METADATA_INVALID");
    }
    const altered = structuredClone(metadata);
    altered.runtime.minimumAppVersion = "3.0.0";
    expect(() => verifyConsumerUpdate(signed(altered), trust, 1, now)).toThrow(
      "UPDATE_INCOMPATIBLE",
    );
  });
  it("rejects unrecognized command fields without reflecting renderer paths or URLs", () => {
    expect(
      parseConsumerUpdateCommand({
        version: 1,
        request_id: randomUUID(),
        action: "install",
      }).action,
    ).toBe("install");
    expect(() =>
      parseConsumerUpdateCommand({
        version: 1,
        request_id: randomUUID(),
        action: "install",
        url: "secret",
      }),
    ).toThrow("UPDATE_REQUEST_INVALID");
  });
});
describe("consumer update transaction and native maintenance ports", () => {
  it("optional discovery never stages/activates and automatic discovery starts disabled", async () => {
    const f = fixture();
    await f.controller.check(new AbortController().signal, true);
    expect(f.ports.candidate).not.toHaveBeenCalled();
    await f.controller.check(new AbortController().signal);
    expect(f.state()?.highestSequence).toBe(2);
    expect(f.ports.stage).not.toHaveBeenCalled();
    expect(f.ports.activate).not.toHaveBeenCalled();
  });
  it("writes each checkpoint before effects and commits only after actual health", async () => {
    const f = fixture();
    vi.mocked(f.ports.activate).mockImplementation(async () => {
      expect(f.state()?.journal?.phase).toBe("activating");
    });
    await f.controller.install(new AbortController().signal);
    expect(f.phases).toEqual([
      "downloading",
      "staged",
      "fenced",
      "activating",
      "health-check",
      "complete",
    ]);
    expect(f.ports.verifyStage).toHaveBeenCalledOnce();
    expect(f.ports.preserveConsumers).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
  });
  it("busy accepted work or live media never activates or cancels the existing consumer", async () => {
    const f = fixture();
    vi.mocked(f.ports.maintenance).mockRejectedValue(new Error("UPDATE_BUSY"));
    await expect(
      f.controller.install(new AbortController().signal),
    ).rejects.toThrow("UPDATE_BUSY");
    expect(f.ports.activate).not.toHaveBeenCalled();
    expect(f.ports.rollback).not.toHaveBeenCalled();
    expect(f.controller.snapshot().phase).toBe("waiting");
  });
  it("signature/hash/staging failure never reaches activation", async () => {
    const f = fixture();
    vi.mocked(f.ports.verifyStage).mockRejectedValue(
      new Error("UPDATE_HASH_INVALID"),
    );
    await expect(
      f.controller.install(new AbortController().signal),
    ).rejects.toThrow("UPDATE_HASH_INVALID");
    expect(f.ports.maintenance).not.toHaveBeenCalled();
    expect(f.ports.activate).not.toHaveBeenCalled();
  });
  it("disk-full activation failure restores exact previous identity without lowering replay floor", async () => {
    const f = fixture();
    vi.mocked(f.ports.activate).mockRejectedValue(
      Object.assign(new Error("disk"), { code: "ENOSPC" }),
    );
    await expect(
      f.controller.install(new AbortController().signal),
    ).rejects.toThrow("disk");
    expect(f.ports.rollback).toHaveBeenCalledWith(
      previous,
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(f.state()?.highestSequence).toBe(2);
    expect(f.state()?.journal?.phase).toBe("rolled-back");
    expect(f.state()?.quarantined).toEqual([consumerUpdateIdentity(metadata)]);
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("failed rollback retains maintenance fence and requires recovery", async () => {
    const f = fixture();
    vi.mocked(f.ports.health).mockResolvedValue(false);
    vi.mocked(f.ports.verifyPrevious).mockResolvedValue(false);
    await expect(
      f.controller.install(new AbortController().signal),
    ).rejects.toThrow("UPDATE_HEALTH_FAILED");
    expect(f.state()?.journal?.phase).toBe("blocked");
    expect(f.release).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.controller.snapshot().problem).toBe("UPDATE_ROLLBACK_UNCONFIRMED");
  });
  it("installer restart retains durable activation boundary instead of falsely claiming complete", async () => {
    const f = fixture();
    vi.mocked(f.ports.activate).mockResolvedValue("restart-required");
    expect(
      (await f.controller.install(new AbortController().signal)).phase,
    ).toBe("restart-required");
    expect(f.state()?.journal?.phase).toBe("restart-required");
    expect(f.ports.restartRequired).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.ports.health).not.toHaveBeenCalled();
  });
  it("interrupted activation resumes idempotent real activation before health and can roll back", async () => {
    const f = fixture();
    f.setState({
      version: 1,
      highestSequence: 2,
      automaticDiscovery: false,
      observed: { sequence: 2, identity: consumerUpdateIdentity(metadata) },
      quarantined: [],
      journal: {
        transaction: randomUUID(),
        identity: consumerUpdateIdentity(metadata),
        signed: signed(),
        previous,
        startedAt: now.toISOString(),
        phase: "activating",
      },
    });
    vi.mocked(f.ports.health)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await f.controller.recover(new AbortController().signal);
    expect(f.ports.stage).not.toHaveBeenCalled();
    expect(f.ports.activate).toHaveBeenCalledOnce();
    expect(f.state()?.journal?.phase).toBe("complete");
  });
  it("rejects same signed sequence with a different identity and same version with changed payload", async () => {
    const f = fixture();
    await f.controller.check(new AbortController().signal);
    const altered = structuredClone(metadata);
    altered.runtime.artifact.sha256 = "f".repeat(64);
    vi.mocked(f.ports.candidate).mockResolvedValue(signed(altered));
    await expect(
      f.controller.check(new AbortController().signal),
    ).rejects.toThrow("UPDATE_REPLAY");
    const g = fixture();
    vi.mocked(g.ports.current).mockResolvedValue(
      consumerUpdateVersions(metadata),
    );
    vi.mocked(g.ports.candidate).mockResolvedValue(
      signed({
        ...metadata,
        app: { ...metadata.app, payloadSha256: "e".repeat(64) },
      }),
    );
    await expect(
      g.controller.check(new AbortController().signal),
    ).rejects.toThrow("UPDATE_IMMUTABLE_IDENTITY_CHANGED");
  });
  it("does not replace UPDATE_BUSY with a release error if native lock is unavailable", async () => {
    const f = fixture();
    vi.mocked(f.ports.lock).mockResolvedValue(null);
    await expect(
      f.controller.install(new AbortController().signal),
    ).rejects.toThrow("UPDATE_BUSY");
    expect(f.ports.candidate).not.toHaveBeenCalled();
  });
  it("strict protected journal rejects unknown state and unbounded retention", () => {
    const f = fixture();
    expect(() =>
      parseConsumerUpdateState({
        version: 1,
        highestSequence: 0,
        automaticDiscovery: false,
        observed: null,
        journal: null,
        quarantined: ["bad"],
      }),
    ).toThrow("UPDATE_STATE_INVALID");
    expect(f.state()).toBeNull();
  });
  it("a partial backup failure stays fenced/retryable without activation or a fictitious rollback", async () => {
    const f = fixture();
    vi.mocked(f.ports.backup).mockRejectedValueOnce(
      new Error("UPDATE_LOW_DISK"),
    );
    await expect(
      f.controller.install(new AbortController().signal),
    ).rejects.toThrow("UPDATE_LOW_DISK");
    expect(f.state()?.journal?.phase).toBe("fenced");
    expect(f.ports.activate).not.toHaveBeenCalled();
    expect(f.ports.rollback).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    await f.controller.recover(new AbortController().signal);
    expect(f.ports.backup).toHaveBeenCalledTimes(2);
    expect(f.ports.activate).toHaveBeenCalledOnce();
    expect(f.state()?.journal?.phase).toBe("complete");
  });
  it("durable rollback capture precedes activation and cancellation after capture cannot replace files", async () => {
    const f = fixture(),
      abort = new AbortController(),
      events: string[] = [];
    vi.mocked(f.ports.backup).mockImplementation(async () => {
      events.push("backup");
      abort.abort();
    });
    vi.mocked(f.ports.activate).mockImplementation(async () => {
      events.push("activate");
    });
    await expect(f.controller.install(abort.signal)).rejects.toThrow();
    expect(events).toEqual(["backup"]);
    expect(f.state()?.journal?.phase).toBe("fenced");
    expect(f.ports.rollback).not.toHaveBeenCalled();
  });
});
describe("cold installed component identities", () => {
  it("reports app-only scope and does not require unavailable runtime/model minima", async () => {
    const f = fixture();
    vi.mocked(f.ports.current).mockResolvedValue({
      app: consumerUpdateVersions(metadata).app,
      runtime: null,
      model: null,
    });
    await f.controller.check(new AbortController().signal);
    expect(f.controller.snapshot()).toMatchObject({
      scope: "app-only",
      phase: "current",
      required: false,
    });
    await f.controller.install(new AbortController().signal);
    expect(f.ports.stage).not.toHaveBeenCalled();
  });
  it("preserves null component identities through journal and cleanup without placeholder hashes", async () => {
    const f = fixture();
    vi.mocked(f.ports.current).mockResolvedValue({
      app: previous.app,
      runtime: null,
      model: null,
    });
    await f.controller.install(new AbortController().signal);
    expect(f.state()!.journal!.previous).toEqual({
      app: previous.app,
      runtime: null,
      model: null,
    });
    expect(f.ports.cleanup).toHaveBeenCalledWith(
      [consumerUpdateIdentity(metadata), previous.app.sha256],
      expect.any(AbortSignal),
    );
  });
  it("rejects contradictory partial installed runtime/model identity", async () => {
    const f = fixture();
    vi.mocked(f.ports.current).mockResolvedValue({
      app: previous.app,
      runtime: previous.runtime,
      model: null,
    });
    await expect(
      f.controller.check(new AbortController().signal),
    ).rejects.toThrow("UPDATE_STATE_INVALID");
    expect(f.ports.stage).not.toHaveBeenCalled();
  });
});
it("verified target with uncertain Main rebind/finalization stays fenced without overwriting a new authority model", async () => {
  const f = fixture();
  f.commit.mockRejectedValueOnce(new Error("NEW_AUTHORITY_UNCONFIRMED"));
  await expect(
    f.controller.install(new AbortController().signal),
  ).rejects.toThrow("UPDATE_FINALIZE_UNCONFIRMED");
  expect(f.ports.rollback).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
  expect(f.state()!.journal!.phase).toBe("health-check");
  expect(f.controller.snapshot().problem).toBe("UPDATE_FINALIZE_UNCONFIRMED");
  await f.controller.recover(new AbortController().signal);
  expect(f.controller.snapshot().phase).toBe("complete");
  expect(f.ports.activate).toHaveBeenCalledOnce();
  expect(f.ports.rollback).not.toHaveBeenCalled();
});
describe("durable operational update scope", () => {
  it("captures app-only before mint while retaining real installed runtime/model identities, then ignores new qualification during recovery", async () => {
    const f = fixture(),
      scope = vi.fn(async () => "app-only" as const);
    f.ports.operationScope = scope;
    vi.mocked(f.ports.stage).mockImplementation(async () => {
      expect(f.state()!.journal!.scope).toBe("app-only");
      expect(f.state()!.journal!.previous).toEqual(previous);
    });
    vi.mocked(f.ports.activate).mockResolvedValueOnce("restart-required");
    expect(
      (await f.controller.install(new AbortController().signal)).scope,
    ).toBe("app-only");
    expect(scope).toHaveBeenCalledOnce();
    scope.mockRejectedValue(
      new Error("qualification unavailable after restart"),
    );
    const restored = new ConsumerUpdateController(f.ports);
    expect((await restored.initialize()).recoveryRequired).toBe(true);
    expect(restored.snapshot().scope).toBe("app-only");
    expect(await restored.recover(new AbortController().signal)).toMatchObject({
      phase: "complete",
      scope: "app-only",
    });
    expect(scope).toHaveBeenCalledOnce();
    expect(f.state()!.journal!.previous.runtime).toEqual(previous.runtime);
    expect(f.state()!.journal!.previous.model).toEqual(previous.model);
    expect(f.ports.stage).toHaveBeenCalledOnce();
    expect(f.ports.activate).toHaveBeenCalledOnce();
    expect(f.ports.rollback).not.toHaveBeenCalled();
  });
  it("does not reclassify a prepared transaction after readiness changes", async () => {
    const f = fixture(),
      scope = vi.fn(async () => "prepared" as const);
    f.ports.operationScope = scope;
    vi.mocked(f.ports.activate).mockResolvedValueOnce("restart-required");
    await f.controller.install(new AbortController().signal);
    scope.mockRejectedValue(new Error("readiness changed"));
    expect(
      (
        await new ConsumerUpdateController(f.ports).recover(
          new AbortController().signal,
        )
      ).scope,
    ).toBe("prepared");
    expect(scope).toHaveBeenCalledOnce();
    expect(f.state()!.journal!.scope).toBe("prepared");
  });
  it("already-current app-only updates do not demand target runtime/model activation or minima", async () => {
    const f = fixture(),
      target = {
        ...metadata,
        required: {
          ...metadata.required,
          minimumRuntimeVersion: "2.0.0",
          minimumModelVersion: "2.0.0",
        },
      };
    f.ports.operationScope = vi.fn(async () => "app-only" as const);
    vi.mocked(f.ports.candidate).mockResolvedValue(signed(target));
    vi.mocked(f.ports.current).mockResolvedValue({
      ...previous,
      app: consumerUpdateVersions(target).app,
    });
    expect(
      await f.controller.check(new AbortController().signal),
    ).toMatchObject({ phase: "current", scope: "app-only", required: false });
    expect(
      (await f.controller.install(new AbortController().signal)).phase,
    ).toBe("current");
    expect(f.ports.stage).not.toHaveBeenCalled();
    expect(f.ports.activate).not.toHaveBeenCalled();
    expect(f.state()!.journal).toBeNull();
  });
  it("normalizes only omitted legacy scope without mutating the supplied protected record", async () => {
    const f = fixture();
    vi.mocked(f.ports.activate).mockResolvedValueOnce("restart-required");
    await f.controller.install(new AbortController().signal);
    const record = structuredClone(f.state()!);
    delete record.journal!.scope;
    expect(parseConsumerUpdateState(record).journal!.scope).toBe("prepared");
    expect(Object.hasOwn(record.journal!, "scope")).toBe(false);
    record.journal!.previous = {
      app: previous.app,
      runtime: null,
      model: null,
    };
    expect(parseConsumerUpdateState(record).journal!.scope).toBe("app-only");
    for (const value of [undefined, null, "unknown", "prepared"]) {
      const bad = structuredClone(record);
      (bad.journal as unknown as { scope: unknown }).scope = value;
      expect(() => parseConsumerUpdateState(bad)).toThrow(
        "UPDATE_STATE_INVALID",
      );
    }
    record.journal!.previous = previous;
    record.journal!.scope = "app-only";
    expect(parseConsumerUpdateState(record).journal!.scope).toBe("app-only");
    delete record.journal!.scope;
    record.journal!.signed = { padding: "" };
    (record.journal!.signed as { padding: string }).padding = "x".repeat(
      16384 - Buffer.byteLength(JSON.stringify(record)),
    );
    expect(Buffer.byteLength(JSON.stringify(record))).toBe(16384);
    expect(() => parseConsumerUpdateState(record)).toThrow(
      "UPDATE_STATE_INVALID",
    );
  });
  it("scope discovery failure or contradictory prepared absence cannot mint or stage a transaction", async () => {
    for (const error of [new Error("UPDATE_STATE_INVALID"), null]) {
      const f = fixture();
      f.ports.operationScope = vi.fn(async () => {
        if (error) throw error;
        return "prepared" as const;
      });
      vi.mocked(f.ports.current).mockResolvedValue({
        app: previous.app,
        runtime: null,
        model: null,
      });
      await expect(
        f.controller.install(new AbortController().signal),
      ).rejects.toThrow("UPDATE_STATE_INVALID");
      expect(f.state()).toBeNull();
      expect(f.ports.stage).not.toHaveBeenCalled();
      expect(f.ports.activate).not.toHaveBeenCalled();
    }
  });
});
