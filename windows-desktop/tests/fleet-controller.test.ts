import { describe, expect, it, vi } from "vitest";
import {
  FleetController,
  type FleetPreparationPort,
} from "../src/main/fleet/controller.js";
import {
  parseFleetRecord,
  fleetRecordAuthority,
  VaultFleetStore,
  type FleetEnrollmentRecord,
} from "../src/main/fleet/store.js";
import { parseFleetCommand } from "../src/shared/fleet-contracts.js";
import type { ConsumerMutexLease } from "../../worker/src/platform/windows/consumer-native.js";
import {
  fleetSid,
  fleetOrigin,
  fleetNow,
  prepared,
  record,
  accountView,
  token,
} from "./fleet-fixtures.js";
function cacheLease(): ConsumerMutexLease {
  return {
    scope: "cache",
    nonce: "a".repeat(64),
    identity: {
      sid: fleetSid,
      sessionId: 1,
      pid: 12345,
      creationTime: "133000000000000000",
    },
    abandoned: false,
  };
}
function fixture(initial: FleetEnrollmentRecord | null = null) {
  let stored = initial ? structuredClone(initial) : null,
    purgedMarker: unknown | null = null,
    view = accountView(),
    scope: { firebaseUid: string; generation: string } | null = {
      firebaseUid: "fixture-user",
      generation: "fixture-generation",
    },
    idToken = token();
  const writes: FleetEnrollmentRecord[] = [],
    calls: {
      path: string;
      body: Record<string, unknown>;
      authorization: string | null;
    }[] = [];
  let sessionState = {
    intent: (initial?.phase === "complete" ? "running" : "stopped") as
      "running" | "paused" | "draining" | "stopped",
    revision: 1,
  };
  const controls = {
    read: vi.fn(async () => ({ ...sessionState })),
    intent: vi.fn(async (intent: typeof sessionState.intent) => {
      sessionState = { intent, revision: sessionState.revision + 1 };
      return { ...sessionState };
    }),
    restart: vi.fn(async () => {
      sessionState = { ...sessionState, revision: sessionState.revision + 1 };
      return { ...sessionState };
    }),
  };
  const preparation: FleetPreparationPort = {
    snapshot: vi.fn(async () => prepared()),
    verify: vi.fn(async () => {}),
    qualify: vi.fn(async () => ({
      ...prepared(),
      qualificationPath: "C:\\Users\\fixture\\qualification.json",
      fixtureDigest: "f".repeat(64),
    })),
    upload: vi.fn(async () => {}),
  };
  const failures = new Map<string, number>();
  const fetcher = vi.fn(async (input: string, init: RequestInit) => {
    const path = new URL(input).pathname,
      body = init.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {},
      headers = new Headers(init.headers);
    calls.push({ path, body, authorization: headers.get("authorization") });
    if ((failures.get(path) ?? 0) > 0) {
      failures.set(path, failures.get(path)! - 1);
      throw new Error("network failed with SECRET");
    }
    if (path === "/users/me/worker-installation")
      return Response.json({
        credential: "e".repeat(43),
        expires_at: new Date(fleetNow + 900000).toISOString(),
      });
    if (path === "/worker/installations")
      return Response.json({
        installation_id: "6b9c4c74-7e0d-4cbd-9f04-2d5ce37019a7",
        phase: "restricted",
        expires_at: new Date(fleetNow + 900000).toISOString(),
        credential: "i".repeat(43),
        replayed: false,
      });
    if (path.endsWith("/reports"))
      return Response.json({
        installation_id: "6b9c4c74-7e0d-4cbd-9f04-2d5ce37019a7",
        phase: "reported",
        outcome_code: null,
        revision: 1,
        replayed: false,
      });
    if (path.endsWith("/activations"))
      return Response.json({
        machine_id: "2a956a35-95d1-4417-9157-fc0189ef67c5",
        status: "active",
        credential_revision: 1,
        replayed: false,
      });
    if (path === "/worker/status")
      return Response.json({
        machine_id: "2a956a35-95d1-4417-9157-fc0189ef67c5",
        status: "active",
        group_id: null,
        policy_revision: 1,
        revision: 1,
        last_seen_at: null,
        active_attempts: 0,
        claims_allowed: true,
      });
    if (path === "/worker/unpairings")
      return Response.json({
        status: "revoked",
        machine_id: "2a956a35-95d1-4417-9157-fc0189ef67c5",
        confirmed: true,
        revision: 2,
      });
    throw new Error("unknown fixture route");
  });
  let failWrite: (value: FleetEnrollmentRecord) => boolean = () => false;
  const controller = new FleetController({
    backendOrigin: fleetOrigin,
    installationId: "491b6421-9b93-4cbb-bcc9-377fa6b60183",
    sid: fleetSid,
    now: () => fleetNow,
    account: {
      view: () => view,
      sessionScope: () => scope,
      assertScope: (s) => {
        if (
          scope?.firebaseUid !== s.firebaseUid ||
          scope.generation !== s.generation
        )
          throw new Error("FLEET_SESSION_CHANGED");
      },
      authorization: async () => idToken,
    },
    store: {
      read: async () => (stored ? structuredClone(stored) : null),
      readPurgedTombstone: () =>
        new VaultFleetStore(
          {
            vaultRead: async (_namespace, key) =>
              key === "purged_tombstone" && purgedMarker !== null
                ? Buffer.from(JSON.stringify(purgedMarker))
                : null,
            vaultWrite: async () => {
              throw new Error("READ_ONLY_FIXTURE");
            },
            acquireMutex: async () => cacheLease(),
            releaseMutex: async () => {},
          },
          fleetSid,
          fleetOrigin,
          () => fleetNow,
        ).readPurgedTombstone(),
      renewInvitationIfCurrent: (expected, replacement) =>
        new VaultFleetStore(
          {
            vaultRead: async () =>
              stored ? Buffer.from(JSON.stringify(stored)) : null,
            vaultWrite: async (_namespace, _key, bytes) => {
              const value = parseFleetRecord(
                JSON.parse(bytes.toString()),
                fleetSid,
                fleetOrigin,
              );
              if (failWrite(value)) throw new Error("FLEET_STATE_CORRUPT");
              writes.push(structuredClone(value));
              stored = structuredClone(value);
            },
            acquireMutex: async () => cacheLease(),
            releaseMutex: async () => {},
          },
          fleetSid,
          fleetOrigin,
          () => fleetNow,
        ).renewInvitationIfCurrent(expected, replacement),
      write: async (value) => {
        if (failWrite(value)) throw new Error("FLEET_STATE_CORRUPT");
        writes.push(structuredClone(value));
        stored = structuredClone(value);
      },
      rememberUnpairAndRetire: async (expected, confirmation) => {
        if (
          !stored ||
          fleetRecordAuthority(stored) !== expected ||
          stored.machineId !== confirmation.machineId ||
          confirmation.revision < 1
        )
          throw new Error("ADVANCED_MACHINE_CHANGED");
        const retired = parseFleetRecord(
          {
            ...stored,
            phase: "revoked",
            retiredAuthority: expected,
            enrollmentCredential: null,
            installationCredential: null,
            machineCredential: null,
          },
          fleetSid,
          fleetOrigin,
        );
        if (failWrite(retired)) throw new Error("FLEET_STATE_CORRUPT");
        writes.push(structuredClone(retired));
        stored = structuredClone(retired);
        return retired;
      },
    },
    preparation,
    controls,
    fetch: fetcher,
  });
  return {
    controller,
    controls,
    preparation,
    calls,
    writes,
    fetcher,
    failures,
    get stored() {
      return stored;
    },
    setView: (v: typeof view) => {
      view = v;
    },
    setToken: (t: string) => {
      idToken = t;
    },
    setScope: (s: typeof scope) => {
      scope = s;
    },
    setStored: (value: FleetEnrollmentRecord) => {
      stored = structuredClone(value);
    },
    setPurgedMarker: (value: unknown | null) => {
      purgedMarker = value;
    },
    setFailWrite: (predicate: typeof failWrite) => {
      failWrite = predicate;
    },
  };
}
describe("Windows fleet enrollment and independent controls", () => {
  it("valid purge requires an explicit approved registration and preserves saved Stop after it completes", async () => {
    const f = fixture(),
      previous = record();
    f.setPurgedMarker({
      version: 1,
      sid: fleetSid,
      machineId: previous.machineId,
      workerId: previous.workerId,
      onboardingRevision: previous.onboardingRevision,
      authority: fleetRecordAuthority(previous),
      purgedAt: new Date(fleetNow - 1000).toISOString(),
    });
    expect(await f.controller.restore()).toMatchObject({
      state: "absent",
      autoEnrollmentAllowed: false,
    });
    expect(f.calls).toEqual([]);
    expect(await f.controller.execute({ type: "ENROLL" })).toMatchObject({
      state: "registered",
      intent: "stopped",
    });
    expect(f.stored?.startAfterEnrollment).toBe(false);
    expect(f.controls.intent).not.toHaveBeenCalled();
    expect(
      f.calls.filter((c) => c.path === "/users/me/worker-installation"),
    ).toHaveLength(1);
  });
  it("corrupt purge marker revokes even a previously valid automatic-registration hint and cannot issue an explicit invitation", async () => {
    const f = fixture();
    expect(await f.controller.restore()).toMatchObject({
      state: "absent",
      autoEnrollmentAllowed: true,
    });
    f.setPurgedMarker({ version: 1, sid: fleetSid, machineId: "damaged" });
    expect(await f.controller.restore()).toMatchObject({
      autoEnrollmentAllowed: false,
      errorCode: "FLEET_STATE_CORRUPT",
    });
    await f.controller.execute({ type: "ENROLL" });
    expect(f.calls).toEqual([]);
    expect(f.writes).toEqual([]);
  });
  it("expired invitation stays interrupted on ordinary restore; explicit same-UID renewal preserves worker/key/request identity then completes the real existing client phases", async () => {
    const initial = record("invitation");
    initial.invitationExpiresAt = new Date(fleetNow - 1).toISOString();
    const f = fixture(initial),
      original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      return new URL(input).pathname === "/users/me/worker-installation"
        ? Response.json({
            credential: "n".repeat(43),
            expires_at: new Date(fleetNow + 900000).toISOString(),
          })
        : response;
    });
    const interrupted = await f.controller.restore();
    expect(interrupted).toMatchObject({
      state: "interrupted",
      errorCode: "FLEET_INVITATION_EXPIRED",
      renewInvitationAvailable: true,
    });
    expect(f.calls).toEqual([]);
    expect(
      await f.controller.execute({ type: "RENEW_INVITATION" }),
    ).toMatchObject({ state: "registered", renewInvitationAvailable: false });
    expect(f.stored).toMatchObject({
      workerId: initial.workerId,
      machineCredential: initial.machineCredential,
      requests: initial.requests,
      onboardingRevision: initial.onboardingRevision,
      ownerUid: initial.ownerUid,
    });
    expect(
      f.calls.filter((c) => c.path === "/users/me/worker-installation"),
    ).toHaveLength(1);
    expect(
      f.calls.find((c) => c.path === "/worker/installations"),
    ).toMatchObject({
      body: { request_id: initial.requests.exchange },
      authorization: `Bearer ${"n".repeat(43)}`,
    });
  });
  it.each(["exchanged", "qualified", "activated", "complete"] as const)(
    "renewal never resets progressed %s enrollment or sends another invitation",
    async (phase) => {
      const initial = record(phase),
        f = fixture(initial);
      await f.controller.execute({ type: "RENEW_INVITATION" });
      expect(f.calls).toEqual([]);
      expect(f.stored).toEqual(initial);
      expect(f.writes).toEqual([]);
    },
  );
  it("requires fresh same-UID Google approval and fences an account switch before CAS publication", async () => {
    const initial = record("invitation");
    initial.invitationExpiresAt = new Date(fleetNow - 1).toISOString();
    const different = fixture(initial);
    different.setScope({ firebaseUid: "other", generation: "other" });
    await different.controller.execute({ type: "RENEW_INVITATION" });
    expect(different.calls).toEqual([]);
    const stale = fixture(initial);
    stale.setToken(token(Math.floor(fleetNow / 1000) - 301));
    expect(
      await stale.controller.execute({ type: "RENEW_INVITATION" }),
    ).toMatchObject({ errorCode: "FLEET_RECENT_AUTH_REQUIRED" });
    expect(stale.calls).toEqual([]);
    const switched = fixture(initial);
    switched.fetcher.mockImplementation(async () => {
      switched.setScope({ firebaseUid: "other", generation: "other" });
      return Response.json({
        credential: "n".repeat(43),
        expires_at: new Date(fleetNow + 900000).toISOString(),
      });
    });
    expect(
      await switched.controller.execute({ type: "RENEW_INVITATION" }),
    ).toMatchObject({ errorCode: "FLEET_SESSION_CHANGED" });
    expect(switched.stored).toEqual(initial);
    expect(switched.writes).toEqual([]);
  });
  it("a concurrently persisted lost exchange ACK defeats exact invitation CAS without erasing restricted credentials", async () => {
    const initial = record("invitation");
    initial.invitationExpiresAt = new Date(fleetNow - 1).toISOString();
    const f = fixture(initial),
      progressed = record("exchanged");
    progressed.workerId = initial.workerId;
    progressed.machineCredential = initial.machineCredential;
    progressed.requests = initial.requests;
    f.fetcher.mockImplementation(async () => {
      f.setStored(progressed);
      return Response.json({
        credential: "n".repeat(43),
        expires_at: new Date(fleetNow + 900000).toISOString(),
      });
    });
    expect(
      await f.controller.execute({ type: "RENEW_INVITATION" }),
    ).toMatchObject({ errorCode: "FLEET_SESSION_CHANGED" });
    expect(f.stored).toEqual(progressed);
    expect(f.writes).toEqual([]);
    expect(f.preparation.qualify).not.toHaveBeenCalled();
  });
  it.each([
    "signed-out",
    "google-required",
    "approval-required",
    "recent-auth-required",
  ])("gates %s without creating an invitation", async (expected) => {
    const f = fixture(),
      v = accountView();
    if (expected === "signed-out") {
      v.state = "signed-out";
      f.setScope(null);
    }
    if (expected === "google-required") v.googleSignInActive = false;
    if (expected === "approval-required")
      v.user!.workerRegistrationAllowed = false;
    if (expected === "recent-auth-required")
      f.setToken(token(Math.floor(fleetNow / 1000) - 301));
    f.setView(v);
    expect(await f.controller.eligibility()).toBe(expected);
    await f.controller.execute({ type: "ENROLL" });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(0);
  });
  it.each([
    token(Math.floor(fleetNow / 1000), "password"),
    token(Math.floor(fleetNow / 1000) + 61),
    token(Math.floor(fleetNow / 1000), "google.com", "other-user"),
    "invalid",
  ])("checks token recent Google owner evidence", async (value) => {
    const f = fixture();
    f.setToken(value);
    expect(await f.controller.eligibility()).toBe("recent-auth-required");
  });
  it("requires prepared GPU/runtime before the remote invitation", async () => {
    const f = fixture();
    vi.mocked(f.preparation.snapshot).mockRejectedValue(new Error("missing"));
    expect(await f.controller.eligibility()).toBe("prepare-required");
    await f.controller.execute({ type: "ENROLL" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("qualifies approved fixture before report and saves every request boundary", async () => {
    const f = fixture();
    expect((await f.controller.execute({ type: "ENROLL" })).state).toBe(
      "registered",
    );
    expect(f.writes.map((row) => row.phase)).toEqual([
      "invitation",
      "exchanged",
      "qualified",
      "uploaded",
      "reported",
      "activated",
      "complete",
    ]);
    expect(f.preparation.qualify).toHaveBeenCalledOnce();
    expect(f.preparation.upload).toHaveBeenCalledOnce();
    expect(
      f.calls.find((c) => c.path.endsWith("/reports"))?.body.runtime,
    ).toMatchObject({ installation_profile: "windows-user" });
    expect(f.stored?.prepared.fixtureDigest).toBe("f".repeat(64));
    expect(f.controls.intent).toHaveBeenCalledWith(
      "running",
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(f.controller.view())).not.toContain("credential");
    expect(JSON.stringify(f.controller.view())).not.toContain("fixture-user");
  });
  it("retains independent enrollment after app account signs out at durable handoff", async () => {
    const f = fixture();
    vi.mocked(f.preparation.verify).mockImplementation(async () => {
      f.setScope(null);
      const v = accountView();
      v.state = "signed-out";
      f.setView(v);
    });
    expect((await f.controller.execute({ type: "ENROLL" })).state).toBe(
      "registered",
    );
    expect(
      f.calls.filter((c) => c.authorization?.includes("Bearer i")),
    ).not.toHaveLength(0);
  });
  it("rejects account change before committing the invitation", async () => {
    const f = fixture();
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (new URL(input).pathname === "/users/me/worker-installation")
        f.setScope({ firebaseUid: "other-user", generation: "next" });
      return response;
    });
    const result = await f.controller.execute({ type: "ENROLL" });
    expect(result.errorCode).toBe("FLEET_SESSION_CHANGED");
    expect(f.writes).toHaveLength(0);
    expect(f.calls).toHaveLength(1);
  });
  it("replays activation with the same saved digest and IDs after uncertain local write", async () => {
    const f = fixture(record("reported"));
    f.setFailWrite((value) => value.phase === "activated");
    expect((await f.controller.execute({ type: "ENROLL" })).state).toBe(
      "interrupted",
    );
    const first = f.calls.find((c) => c.path.endsWith("/activations"))!.body;
    f.setFailWrite(() => false);
    expect((await f.controller.execute({ type: "ENROLL" })).state).toBe(
      "registered",
    );
    expect(
      f.calls.filter((c) => c.path.endsWith("/activations"))[1]?.body,
    ).toEqual(first);
    expect(
      f.calls.some((c) => c.path === "/users/me/worker-installation"),
    ).toBe(false);
  });
  it.each([
    "invitation",
    "exchanged",
    "qualified",
    "uploaded",
    "reported",
    "activated",
    "complete",
  ] as const)(
    "recovers an interrupted %s journal write with saved request identities",
    async (checkpoint) => {
      const f = fixture();
      let failed = false;
      f.setFailWrite((value) => {
        if (value.phase === checkpoint && !failed) {
          failed = true;
          return true;
        }
        return false;
      });
      expect((await f.controller.execute({ type: "ENROLL" })).errorCode).toBe(
        "FLEET_STATE_CORRUPT",
      );
      f.setFailWrite(() => false);
      expect((await f.controller.execute({ type: "ENROLL" })).state).toBe(
        "registered",
      );
      for (const suffix of ["/reports", "/activations"]) {
        const requests = f.calls.filter((call) => call.path.endsWith(suffix));
        expect(new Set(requests.map((call) => call.body.request_id)).size).toBe(
          1,
        );
      }
      const exchanges = f.calls.filter(
        (call) => call.path === "/worker/installations",
      );
      expect(new Set(exchanges.map((call) => call.body.request_id)).size).toBe(
        1,
      );
      expect(f.stored?.phase).toBe("complete");
    },
  );
  it("never activates a rejected approved qualification", async () => {
    const f = fixture(record("uploaded"));
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) =>
      new URL(input).pathname.endsWith("/reports")
        ? Response.json({
            installation_id: f.stored!.installationId,
            phase: "reported",
            outcome_code: "QUALIFICATION_FAILED",
            revision: 1,
            replayed: false,
          })
        : original(input, init),
    );
    const result = await f.controller.execute({ type: "ENROLL" });
    expect(result.errorCode).toBe("FLEET_QUALIFICATION_REJECTED");
    expect(f.calls.some((c) => c.path.endsWith("/activations"))).toBe(false);
  });
  it("resumes a committed installation while the app is signed out", async () => {
    const f = fixture(record("exchanged"));
    f.setScope(null);
    expect((await f.controller.execute({ type: "ENROLL" })).state).toBe(
      "registered",
    );
    expect(
      f.calls.some((c) => c.path === "/users/me/worker-installation"),
    ).toBe(false);
  });
  it.each([
    ["START", "running"],
    ["PAUSE", "paused"],
    ["DRAIN", "draining"],
    ["RESUME", "running"],
    ["STOP", "stopped"],
  ] as const)("uses the session authority for %s", async (type, intent) => {
    const f = fixture(record());
    await f.controller.restore();
    await f.controller.execute({ type });
    expect(f.controller.view().intent).toBe(intent);
    expect(f.controls.intent).toHaveBeenCalledWith(
      intent,
      expect.any(String),
      expect.any(AbortSignal),
    );
  });
  it("does not turn Restart into Start or erase explicit Stop", async () => {
    const r = record();

    const f = fixture(r);
    await f.controller.restore();
    await f.controller.execute({ type: "STOP" });
    await f.controller.execute({ type: "RESTART" });
    expect(f.controls.restart).toHaveBeenCalledOnce();
    expect(f.controller.view().intent).toBe("stopped");
  });
  it("preserves the confirmed session authority after a failed intent write", async () => {
    const f = fixture(record());
    await f.controller.restore();
    f.controls.intent.mockRejectedValueOnce(
      new Error("FLEET_CONTROL_UNAVAILABLE"),
    );
    expect((await f.controller.execute({ type: "STOP" })).errorCode).toBe(
      "FLEET_CONTROL_UNAVAILABLE",
    );
    expect(f.controller.view().intent).toBe("running");
    await f.controller.restore();
    expect(f.controller.view().intent).toBe("running");
  });
  it("reads back a committed session command after its response was lost", async () => {
    const f = fixture(record());
    await f.controller.restore();
    const actual = f.controls.intent.getMockImplementation()!;
    f.controls.intent.mockImplementationOnce(async (intent) => {
      await actual(intent);
      throw new Error("FLEET_CONTROL_UNAVAILABLE");
    });
    expect((await f.controller.execute({ type: "STOP" })).errorCode).toBe(
      "FLEET_CONTROL_UNAVAILABLE",
    );
    expect(f.controller.view().intent).toBe("running");
    expect((await f.controller.restore()).intent).toBe("stopped");
    expect(f.writes).toHaveLength(0);
  });
  it("does not automatically Start when Stop changes the session revision during onboarding", async () => {
    const f = fixture();
    vi.mocked(f.preparation.upload).mockImplementation(async () => {
      await f.controls.intent("stopped");
    });
    expect((await f.controller.execute({ type: "ENROLL" })).state).toBe(
      "registered",
    );
    expect(f.controller.view().intent).toBe("stopped");
    expect(f.controls.intent).toHaveBeenCalledTimes(1);
  });
  it("restores an interrupted committed handoff without an app account", async () => {
    const f = fixture(record("exchanged"));
    f.setScope(null);
    expect((await f.controller.restore()).state).toBe("registered");
    expect(
      f.calls.some((c) => c.path === "/users/me/worker-installation"),
    ).toBe(false);
  });
  it("revokes only the credential-owned machine after a confirmed Stop without forcing accepted work", async () => {
    const f = fixture(record());
    await f.controller.restore();
    const result = await f.controller.execute({
      type: "REVOKE",
      confirmed: true,
    });
    expect(result.state).toBe("revoked");
    expect(result.intent).toBe("stopped");
    expect(f.calls.find((c) => c.path === "/worker/unpairings")?.body).toEqual({
      force: false,
    });
    expect(f.stored?.phase).toBe("revoked");
  });
  it("marks revoked credentials unavailable without weakening independent personal readiness", async () => {
    const f = fixture(record()),
      original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) =>
      new URL(input).pathname === "/worker/status"
        ? new Response(JSON.stringify({ code: "WORKER_MACHINE_DELETED" }), {
            status: 401,
            headers: { "content-type": "application/problem+json" },
          })
        : original(input, init),
    );
    const result = await f.controller.restore();
    expect(result.state).toBe("revoked");
    expect(result.claimsAllowed).toBe(false);
    expect(result.errorCode).toBe("FLEET_PERMISSION_REVOKED");
    expect(f.preparation.snapshot).not.toHaveBeenCalled();
  });
  it("preserves durable fleet state on UI disposal", async () => {
    const f = fixture(record());
    await f.controller.restore();
    f.controller.dispose();
    expect(f.stored?.phase).toBe("complete");
    expect(f.controls.intent).not.toHaveBeenCalled();
    await expect(f.controller.execute({ type: "STOP" })).rejects.toThrow(
      "FLEET_CONTROL_UNAVAILABLE",
    );
  });
});
describe("fleet private store and command boundary", () => {
  it("uses only the fleet DPAPI namespace and refuses foreign SID/origin/report", async () => {
    let bytes: Buffer | null = null;
    const native = {
      acquireMutex: vi.fn(async () => cacheLease()),
      releaseMutex: vi.fn(async () => {}),
      vaultRead: vi.fn(async (_ns: string, key: string) =>
        key === "enrollment" && bytes ? Buffer.from(bytes) : null,
      ),
      vaultWrite: vi.fn(
        async (_ns: string, _key: string, value: Uint8Array) => {
          bytes = Buffer.from(value);
        },
      ),
    };
    const store = new VaultFleetStore(native, fleetSid, fleetOrigin);
    const r = record();
    await store.write(r);
    expect(native.acquireMutex).toHaveBeenCalledWith("cache");
    expect(native.releaseMutex).toHaveBeenCalledWith(cacheLease());
    expect(native.vaultWrite).toHaveBeenCalledWith(
      "fleet",
      "enrollment",
      expect.any(Buffer),
    );
    expect(await store.read()).toEqual(r);
    expect(() => parseFleetRecord(r, "S-1-5-21-9-8-7-1001")).toThrow(
      "FLEET_STATE_CORRUPT",
    );
    expect(() =>
      parseFleetRecord(r, fleetSid, "https://other.example.invalid"),
    ).toThrow("FLEET_STATE_CORRUPT");
    const bad = record();
    bad.prepared.report.runtime.installationProfile = undefined as never;
    expect(() => parseFleetRecord(bad, fleetSid)).toThrow(
      "FLEET_STATE_CORRUPT",
    );
  });
  it("refuses a contended fleet write without mutating the vault", async () => {
    const native = {
      acquireMutex: vi.fn(async () => null),
      releaseMutex: vi.fn(async () => {}),
      vaultRead: vi.fn(async () => null),
      vaultWrite: vi.fn(async () => {}),
    };
    await expect(
      new VaultFleetStore(native, fleetSid, fleetOrigin).write(record()),
    ).rejects.toThrow("FLEET_BUSY");
    expect(native.vaultWrite).not.toHaveBeenCalled();
    expect(native.releaseMutex).not.toHaveBeenCalled();
  });
  it("releases the exact mutex after a failed vault write", async () => {
    const lease = cacheLease();
    const native = {
      acquireMutex: vi.fn(async () => lease),
      releaseMutex: vi.fn(async () => {}),
      vaultRead: vi.fn(async () => null),
      vaultWrite: vi.fn(async () => {
        throw new Error("fixture-write-failed");
      }),
    };
    await expect(
      new VaultFleetStore(native, fleetSid, fleetOrigin).write(record()),
    ).rejects.toThrow("fixture-write-failed");
    expect(native.releaseMutex).toHaveBeenCalledExactlyOnceWith(lease);
  });
  it("rejects oversized plaintext before locking or writing", async () => {
    const native = {
      acquireMutex: vi.fn(async () => cacheLease()),
      releaseMutex: vi.fn(async () => {}),
      vaultRead: vi.fn(async () => Buffer.alloc(16385)),
      vaultWrite: vi.fn(async () => {}),
    };
    const store = new VaultFleetStore(native, fleetSid, fleetOrigin);
    await expect(store.read()).rejects.toThrow("FLEET_STATE_CORRUPT");
    const oversized = record();
    oversized.prepared.output.path = "C:\\Users\\fixture\\" + "声".repeat(3000);
    oversized.prepared.qualificationPath =
      "C:\\Users\\fixture\\" + "声".repeat(3000);
    expect(() =>
      parseFleetRecord(oversized, fleetSid, fleetOrigin),
    ).not.toThrow();
    await expect(store.write(oversized)).rejects.toThrow("FLEET_STATE_CORRUPT");
    expect(native.acquireMutex).not.toHaveBeenCalled();
    expect(native.vaultWrite).not.toHaveBeenCalled();
  });
  it("requires explicit revoke and rejects arbitrary CLI input", () => {
    expect(() => parseFleetCommand({ type: "REVOKE" })).toThrow();
    expect(() =>
      parseFleetCommand({ type: "START", command: "sc.exe stop" }),
    ).toThrow();
    expect(parseFleetCommand({ type: "REVOKE", confirmed: true })).toEqual({
      type: "REVOKE",
      confirmed: true,
    });
  });
});
