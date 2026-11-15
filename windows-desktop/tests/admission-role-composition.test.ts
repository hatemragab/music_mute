import { randomBytes, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createRoleGpuGateway,
  createQualifiedSessionGpuAdmission,
} from "../src/main/admission/session-admission.js";
import { BrokerPersonalAdmission } from "../src/main/personal/broker-admission.js";
import { PersonalProcessingController } from "../src/main/personal/controller.js";
import { PersonalCommandRouter } from "../src/main/personal/server.js";
import { PersonalAgentClient } from "../src/main/personal/session-port.js";
import { DirectmlPersonalRunner } from "../src/main/personal/runner.js";
import { FleetInferenceTracker } from "../src/main/fleet/inference.js";
import { FleetRoleControl } from "../src/main/fleet/role-control.js";
import { FleetRuntimeControl } from "../src/main/fleet/runtime-control.js";
import { parseFleetChildCommand } from "../src/main/fleet/channel.js";
import type {
  ConsumerGpuLease,
  ConsumerOwnedProcess,
  ConsumerProcessIdentity,
  WindowsConsumerNative,
} from "../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../src/main/host-context.js";
import type {
  SessionChildContext,
  SessionRuntimeContext,
} from "../src/main/session/context.js";
import type { GpuPersistentState } from "../src/main/admission/gpu-broker.js";
import {
  personalConfiguration,
  personalGpu as gpu,
  personalPeer as peer,
} from "./personal-fixtures.js";

vi.mock("../src/main/prepare/private-files.js", () => ({
  privateFingerprint: vi.fn(
    async () => personalConfiguration().modelFingerprint,
  ),
  writePrivateAtomic: vi.fn(async () => {}),
  readPrivateBytes: vi.fn(),
}));
const identity = (pid: number): ConsumerProcessIdentity => ({ ...peer, pid });
const owned = (role: ConsumerOwnedProcess["role"], pid: number) => ({
  role,
  nonce: randomBytes(32).toString("hex"),
  identity: identity(pid),
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** Actual broker, private clients/router, role adapters and runner/controller.
 * Only named-pipe/kernel/codec/file observations are injected. No Win32, GPU,
 * backend claim, model/media execution or filesystem installation runs here. */
async function fixture(
  holdPersonalGrant = false,
  distinctFleetGpu = false,
  loseReleaseReply = false,
  physicalBusy = false,
) {
  const fleetGpu = distinctFleetGpu
    ? { ...gpu, luid: "0000000000005678", deviceIndex: 1 }
    : gpu;
  const physicalByGpu = new Map<string, "personal" | "fleet">();
  const config = personalConfiguration(),
    owners = { personal: owned("personal", 200), fleet: owned("fleet", 300) },
    sessionOwner = owned("session-agent", 400),
    events: string[] = [],
    cleanup = deferred(),
    grant = deferred();
  let saved: GpuPersistentState | null = null,
    fleetNativeIdle = true,
    personalNativeIdle = true,
    fleetPending = true,
    broker!: Awaited<ReturnType<typeof createQualifiedSessionGpuAdmission>>,
    router!: PersonalCommandRouter;
  const savedFleetIntent = "running";
  const protectedState = new Map<string, Buffer>();
  const ticket = (
    owner: ConsumerOwnedProcess,
    server: ConsumerProcessIdentity,
  ) =>
    Buffer.from(
      JSON.stringify({
        version: 1,
        owner,
        server,
        channel: "c".repeat(64),
        nonce: randomBytes(32).toString("hex"),
        expiresAt: Date.now() + 30_000,
      }),
    );
  const acquire = async (
    role: "personal" | "fleet",
  ): Promise<ConsumerGpuLease | null> => {
    const selected = role === "personal" ? gpu : fleetGpu;
    if (physicalBusy) {
      events.push(`${role}:physical-busy`);
      return null;
    }
    if (physicalByGpu.has(selected.luid)) return null;
    physicalByGpu.set(selected.luid, role);
    events.push(`${role}:physical-acquire`);
    return {
      luid: selected.luid,
      nonce: randomBytes(32).toString("hex"),
      identity: identity(role === "personal" ? 201 : 301),
      gpu: selected,
      abandoned: false,
    };
  };
  const release = async (
    role: "personal" | "fleet",
    lease: ConsumerGpuLease,
  ) => {
    expect(physicalByGpu.get(lease.luid)).toBe(role);
    expect(lease.gpu).toEqual(role === "personal" ? gpu : fleetGpu);
    events.push(`${role}:physical-release`);
    physicalByGpu.delete(lease.luid);
  };
  const verifyOwnedPeer = vi.fn(
    async (owner: ConsumerOwnedProcess, actual: ConsumerProcessIdentity) => {
      const expected =
        owner.role === "personal" ? owners.personal : owners.fleet;
      expect(owner).toEqual(expected);
      expect(actual.sid).toBe(peer.sid);
      expect(actual.creationTime).toBe(peer.creationTime);
      expect([100, 201, 301]).toContain(actual.pid);
    },
  );
  const tracker = new FleetInferenceTracker(
    {
      start: vi.fn(async () => {
        events.push("fleet:accepted-work");
        fleetNativeIdle = false;
      }),
      stop: vi.fn(async () => {
        events.push("fleet:stop-ack");
      }),
      restart: vi.fn(),
      child: vi.fn(),
    },
    async () => fleetNativeIdle,
  );
  await tracker.initialize();
  const runtime = new FleetRuntimeControl({
    processId: 300,
    runtime: { hintAvailableWork: vi.fn(), stop: () => tracker.stop() },
    setIntent: vi.fn(async () => {
      throw new Error("admission must not rewrite saved intent");
    }),
    status: vi.fn(async () => {
      throw new Error("this fixture has no backend claim/status");
    }),
    closed: () => false,
  });
  const fleet = new FleetRoleControl({
    runtime,
    gpuLuid: fleetGpu.luid,
    idle: () => tracker.idle(),
    setPending: async (pending) => {
      fleetPending = pending;
      events.push(`fleet:fence:${pending}`);
    },
    acquireGuard: () => acquire("fleet"),
    releaseGuard: (lease) => release("fleet", lease),
  });
  const parentNative = {
    identity: async () => identity(401),
    enumerateGpus: async () => (distinctFleetGpu ? [gpu, fleetGpu] : [gpu]),
    legacyWorkerConflict: async () => false,
    ownedTreeExited: async () => false,
    vaultRead: async (_namespace: string, key: string) =>
      key === "fleet_ticket"
        ? ticket(owners.fleet, identity(301))
        : protectedState.has(key)
          ? Buffer.from(protectedState.get(key)!)
          : null,
    vaultWrite: async (_namespace: string, key: string, bytes: Buffer) => {
      protectedState.set(key, Buffer.from(bytes));
      if (key === `gpu_broker_${gpu.luid}`) {
        saved = JSON.parse(bytes.toString());
        events.push(
          saved?.active
            ? `persist:${saved.active.request.kind}`
            : "persist:idle",
        );
      }
    },
    vaultDelete: async (_namespace: string, key: string) => {
      protectedState.delete(key);
    },
    pipeConnect: async ({ payload }: { payload: Uint8Array }) =>
      Buffer.from(
        JSON.stringify(
          await fleet.execute(parseFleetChildCommand(Buffer.from(payload))),
        ),
      ),
    close: vi.fn(async () => {}),
  };
  const childNative = (role: "personal" | "fleet") =>
    ({
      identity: async () => identity(role === "personal" ? 100 : 301),
      vaultRead: async (_namespace: string, key: string) => {
        expect(key).toBe("session_ticket");
        return ticket(sessionOwner, identity(401));
      },
      processIdentity: async (pid: number) =>
        pid === 400 ? sessionOwner.identity : null,
      claimSessionTicket: async () => true,
      pipeConnect: async ({ payload }: { payload: Uint8Array }) => {
        const frame = JSON.parse(Buffer.from(payload).toString());
        if (frame.action === "request_personal")
          events.push("personal:admission-request");
        const reply = await broker.dispatch(
          payload,
          identity(role === "personal" ? 100 : 301),
        );
        if (loseReleaseReply && frame.action === "release_personal") {
          loseReleaseReply = false;
          events.push("personal:release-ack-lost");
          throw new Error("PIPE_REPLY_LOST");
        }
        if (
          holdPersonalGrant &&
          role === "personal" &&
          frame.action === "request_personal"
        ) {
          events.push("personal:grant-reply-held");
          await grant.promise;
        }
        return reply;
      },
    }) as unknown as WindowsConsumerNative;
  const childContext = (role: "personal" | "fleet"): SessionChildContext => ({
    releaseRoot: config.releaseRoot,
    personalRoot: config.personalRoot,
    fleetRoot: "C:\\fixture\\MusicMuteWorker",
    role,
    ownerIdentity: owners[role].identity,
    ownershipNonce: owners[role].nonce,
    native: childNative(role),
    openNative: async () => childNative(role),
  });
  const personalNative = {
    bootIdentity: async () => config.bootIdentity,
    enumerateGpus: async () => [gpu],
    acquireGpuGuard: () => acquire("personal"),
    releaseGpuGuard: (lease: ConsumerGpuLease) => release("personal", lease),
    inferenceIdle: async () => personalNativeIdle,
  };
  const personal = new BrokerPersonalAdmission(
    personalNative as unknown as WindowsConsumerNative,
    createRoleGpuGateway(childContext("personal")),
  );
  const child = {
    start: vi.fn(async () => ({
      protocolVersion: 1 as const,
      type: "result" as const,
      requestId: randomUUID(),
      incarnation: randomUUID(),
      sentAt: new Date().toISOString(),
      payload: {},
    })),
    request: vi.fn(async () => {
      expect(physicalByGpu.get(gpu.luid)).toBe("personal");
      expect(saved?.active?.request.kind).toBe("personal");
      events.push("personal:model-command");
      personalNativeIdle = false;
      return {
        protocolVersion: 1 as const,
        type: "result" as const,
        requestId: randomUUID(),
        incarnation: randomUUID(),
        sentAt: new Date().toISOString(),
        payload: { recipeId: "kim-vocals-v2", recipeRevision: 6 },
      };
    }),
    stop: vi.fn(async () => {
      events.push("personal:stop-ack");
      personalNativeIdle = true;
    }),
  };
  const runner = new DirectmlPersonalRunner({
    retainModel: false,
    host: { native: personalNative } as unknown as HostContext,
    configuration: config,
    hardware: async () => [gpu],
    admission: personal,
    child: () => child,
  });
  const processing = new PersonalProcessingController({
    runner,
    storage: {
      consume: async () => ({
        path: "C:\\private\\input.wav",
        name: "input.wav",
        bytes: 3,
        sha256: "a".repeat(64),
      }),
      workDirectory: async () => "C:\\private\\work",
      commit: async () => ({
        original: {
          id: randomUUID(),
          kind: "original",
          name: "original.wav",
          bytes: 3,
          sha256: "a".repeat(64),
          durationSeconds: 3,
          contentType: "audio/wav",
        },
        vocals: {
          id: randomUUID(),
          kind: "vocals",
          name: "vocals.mp3",
          bytes: 3,
          sha256: "b".repeat(64),
          durationSeconds: 3,
          contentType: "audio/mpeg",
        },
      }),
      cleanup: async () => {
        events.push("personal:cleanup-held");
        await cleanup.promise;
        events.push("personal:cleanup-confirmed");
      },
    },
  });
  router = new PersonalCommandRouter(processing, config, personal);
  const client = new PersonalAgentClient(
    {
      native: {
        vaultRead: async () => ticket(owners.personal, identity(201)),
        pipeConnect: async ({ payload }: { payload: Uint8Array }) =>
          Buffer.from(
            JSON.stringify(
              (await router.command(Buffer.from(payload), config.admissionPeer))
                .reply,
            ),
          ),
      } as unknown as WindowsConsumerNative,
      verifyOwnedPeer,
    },
    undefined,
    "personal_admission_ticket",
  );
  client.bind(owners.personal);
  const context = {
    native: parentNative,
    openNative: async () => parentNative,
    verifyOwnedPeer,
  } as unknown as SessionRuntimeContext;
  broker = await createQualifiedSessionGpuAdmission(context, {
    personal: client,
    currentOwner: (role) => owners[role],
    certificateEvents: () => () => {},
    readRoleGpu: async (role) => (role === "fleet" ? fleetGpu : gpu),
  });
  return {
    events,
    broker,
    processing,
    child,
    personal,
    tracker,
    savedFleetIntent,
    fleetGateway: createRoleGpuGateway(childContext("fleet")),
    finishFleet: () => {
      fleetNativeIdle = true;
    },
    finishCleanup: cleanup.resolve,
    deliverGrant: grant.resolve,
    physical: (luid = gpu.luid) => physicalByGpu.get(luid) ?? null,
    fleetGpu,
    fleetPending: () => fleetPending,
    saved: () => saved,
    allowPhysical: () => {
      physicalBusy = false;
    },
    submit: () =>
      processing.submit(
        {
          ownerId: randomUUID(),
          requestId: randomUUID(),
          input: { kind: "file", capability: randomUUID() },
          rightsConfirmed: true,
          recipeId: "kim-vocals-v2",
        },
        null,
      ),
  };
}

it("joins actual Session/client/router/personal/fleet adapters: accepted work and native cleanup precede priority, model command and Ready", async () => {
  const f = await fixture(),
    fleetId = randomUUID(),
    fleetLease = await f.fleetGateway.acquire(
      { jobId: fleetId, gpu },
      new AbortController().signal,
    );
  await f.tracker.start();
  const job = f.submit();
  await vi.waitFor(() =>
    expect(f.processing.snapshot(job.ownerId)[0]).toMatchObject({
      state: "preparing",
      stage: "preparation",
      progress: null,
      waitReason: "waiting-for-worker",
    }),
  );
  expect(f.broker.broker.snapshot().state).toBe("waiting-for-worker");
  expect(f.fleetPending()).toBe(true);
  expect(f.physical()).toBe("fleet");
  expect(f.child.request).not.toHaveBeenCalled();
  await expect(f.tracker.stop()).rejects.toThrow("FLEET_STOP_UNCONFIRMED");
  await expect(
    f.fleetGateway.release({
      jobId: fleetId,
      leaseNonce: fleetLease.leaseNonce,
      exited: true,
      cleaned: true,
    }),
  ).rejects.toThrow("GPU_CHILDREN_STILL_ACTIVE");
  expect(f.physical()).toBe("fleet");
  f.finishFleet();
  await f.tracker.stop();
  await f.fleetGateway.release({
    jobId: fleetId,
    leaseNonce: fleetLease.leaseNonce,
    exited: true,
    cleaned: true,
  });
  await vi.waitFor(() => expect(f.events).toContain("personal:cleanup-held"));
  expect(f.processing.snapshot(job.ownerId)[0]?.state).toBe("preparing");
  expect(f.processing.snapshot(job.ownerId)[0]?.waitReason).toBeNull();
  expect(f.physical()).toBe("personal");
  expect(f.personal.status(job.id)).toMatchObject({
    held: true,
    exited: false,
    cleaned: false,
  });
  f.finishCleanup();
  await vi.waitFor(() =>
    expect(f.processing.snapshot(job.ownerId)[0]?.state).toBe("ready"),
  );
  expect(f.processing.isIdle()).toBe(true);
  expect(f.saved()?.active).toBeNull();
  expect(f.physical()).toBeNull();
  expect(f.fleetPending()).toBe(false);
  expect(f.savedFleetIntent).toBe("running");
  expect(f.events.indexOf("fleet:physical-release")).toBeLessThan(
    f.events.indexOf("personal:physical-acquire"),
  );
  expect(f.events.indexOf("persist:personal")).toBeLessThan(
    f.events.indexOf("personal:model-command"),
  );
  expect(f.events.indexOf("personal:cleanup-confirmed")).toBeLessThan(
    f.events.indexOf("personal:physical-release"),
  );
  await f.processing.stop();
  await f.broker.close();
});
it("actual native guard contention reaches the personal snapshot promptly and unchanged broker events do not spin admission", async () => {
  const f = await fixture(false, false, false, true),
    job = f.submit();
  await vi.waitFor(() =>
    expect(f.processing.snapshot(job.ownerId)[0]).toMatchObject({
      state: "preparing",
      stage: "preparation",
      progress: null,
      waitReason: "gpu-busy",
    }),
  );
  expect(f.child.request).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(
      f.events.filter((event) => event === "personal:admission-request"),
    ).toHaveLength(2),
  );
  for (let i = 0; i < 3; i++) await f.broker.broker.recover();
  expect(
    f.events.filter((event) => event === "personal:admission-request"),
  ).toHaveLength(2);
  f.allowPhysical();
  await f.broker.broker.recover();
  await vi.waitFor(() => expect(f.events).toContain("personal:cleanup-held"));
  expect(f.processing.snapshot(job.ownerId)[0]?.waitReason).toBeNull();
  expect(f.child.request).toHaveBeenCalledOnce();
  f.finishCleanup();
  await f.processing.wait(job.id);
  expect(f.processing.snapshot(job.ownerId)[0]).toMatchObject({
    state: "ready",
    waitReason: null,
  });
  await f.processing.stop();
  await f.broker.close();
});
it("cancel clears the received worker wait before teardown and a late grant cannot restore it or run a model", async () => {
  const f = await fixture(),
    fleetId = randomUUID(),
    lease = await f.fleetGateway.acquire(
      { jobId: fleetId, gpu },
      new AbortController().signal,
    );
  await f.tracker.start();
  const job = f.submit();
  await vi.waitFor(() =>
    expect(f.processing.snapshot(job.ownerId)[0]?.waitReason).toBe(
      "waiting-for-worker",
    ),
  );
  const cancelling = f.processing.cancel(job.ownerId, job.id);
  expect(f.processing.snapshot(job.ownerId)[0]?.waitReason).toBeNull();
  expect(f.child.request).not.toHaveBeenCalled();
  f.finishFleet();
  await f.tracker.stop();
  await f.fleetGateway.release({
    jobId: fleetId,
    leaseNonce: lease.leaseNonce,
    exited: true,
    cleaned: true,
  });
  f.finishCleanup();
  await cancelling;
  expect(f.processing.snapshot(job.ownerId)[0]).toMatchObject({
    state: "cancelled",
    waitReason: null,
  });
  expect(f.child.request).not.toHaveBeenCalled();
  expect(f.physical()).toBeNull();
  await f.processing.stop();
  await f.broker.close();
});
it("a canceled actual role acquire with late logical reply cannot run a model; exact cleanup cancels its already-held physical lease", async () => {
  const f = await fixture(true),
    job = f.submit();
  await vi.waitFor(() =>
    expect(f.events).toContain("personal:grant-reply-held"),
  );
  const cancelling = f.processing.cancel(job.ownerId, job.id);
  await vi.waitFor(() => expect(f.events).toContain("personal:stop-ack"));
  expect(f.physical()).toBe("personal");
  expect(f.child.request).not.toHaveBeenCalled();
  expect(f.processing.isIdle()).toBe(false);
  f.deliverGrant();
  await vi.waitFor(() => expect(f.events).toContain("personal:cleanup-held"));
  expect(f.physical()).toBe("personal");
  f.finishCleanup();
  await cancelling;
  expect(f.processing.snapshot(job.ownerId)[0]?.state).toBe("cancelled");
  expect(f.child.request).not.toHaveBeenCalled();
  expect(f.saved()?.active).toBeNull();
  expect(f.physical()).toBeNull();
  expect(f.processing.isIdle()).toBe(true);
  await f.processing.stop();
  await f.broker.close();
});
it("independently qualified secondary fleet and primary personal adapters receive separate real broker/role guards without waiting for accepted work on the other GPU", async () => {
  const f = await fixture(false, true),
    fleetId = randomUUID(),
    lease = await f.fleetGateway.acquire(
      { jobId: fleetId, gpu: f.fleetGpu },
      new AbortController().signal,
    );
  await f.tracker.start();
  const job = f.submit();
  await vi.waitFor(() => expect(f.events).toContain("personal:cleanup-held"));
  expect(f.physical()).toBe("personal");
  expect(f.physical(f.fleetGpu.luid)).toBe("fleet");
  expect(f.child.request).toHaveBeenCalledOnce();
  expect(f.events).not.toContain("fleet:stop-ack");
  f.finishCleanup();
  await f.processing.wait(job.id);
  expect(f.processing.snapshot(job.ownerId)[0]?.state).toBe("ready");
  expect(f.physical()).toBeNull();
  expect(f.physical(f.fleetGpu.luid)).toBe("fleet");
  f.finishFleet();
  await f.tracker.stop();
  await f.fleetGateway.release({
    jobId: fleetId,
    leaseNonce: lease.leaseNonce,
    exited: true,
    cleaned: true,
  });
  await f.processing.stop();
  await f.broker.close();
});
it("lost successful release reply retains the exact terminal cleanup; owned cancel retries only the same receipt, no second inference/physical release", async () => {
  const f = await fixture(false, false, true),
    job = f.submit();
  f.finishCleanup();
  await f.processing.wait(job.id);
  expect(f.events).toContain("personal:release-ack-lost");
  expect(f.processing.snapshot(job.ownerId)[0]).toMatchObject({
    state: "failed",
    error: "STOP_UNCONFIRMED",
  });
  expect(f.processing.isIdle()).toBe(false);
  expect(f.physical()).toBeNull();
  expect(f.saved()?.active).toBeNull();
  await f.processing.cancel(job.ownerId, job.id);
  expect(f.processing.snapshot(job.ownerId)[0]).toMatchObject({
    state: "cancelled",
    error: "CANCELLED",
  });
  expect(f.processing.isIdle()).toBe(true);
  expect(f.child.request).toHaveBeenCalledOnce();
  expect(
    f.events.filter((event) => event === "personal:physical-release"),
  ).toHaveLength(1);
  await f.processing.stop();
  await f.broker.close();
});
