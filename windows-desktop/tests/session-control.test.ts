import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionDispatcher,
  parseSessionTicket,
  SessionClient,
} from "../src/main/session/control.js";
import { parseSessionCommand } from "../src/shared/session-contracts.js";
import { parseSessionAgentConfiguration } from "../src/main/session/bootstrap.js";
import type { SessionSupervisor } from "../src/main/session/supervisor.js";
import type { PersonalAgentClient } from "../src/main/personal/session-port.js";
import type { WindowsConsumerNative } from "../../worker/src/platform/windows/consumer-native.js";
const peer = {
  sid: "S-1-5-21-1-2-3-1001",
  sessionId: 2,
  pid: 50,
  creationTime: "133700000000001",
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
describe("authenticated session control contracts", () => {
  it("strictly rejects unknown actions/fields/invalid intent without reflecting raw input", () => {
    expect(
      parseSessionCommand(
        encode({
          version: 1,
          request_id: randomUUID(),
          action: "fleet_intent",
          intent: "paused",
        }),
      ),
    ).toMatchObject({ intent: "paused" });
    for (const command of [
      { action: "shell", argv: "secret" },
      { action: "fleet_intent", intent: "cpu" },
      { action: "status", extra: "secret" },
    ])
      expect(() =>
        parseSessionCommand(
          encode({ version: 1, request_id: randomUUID(), ...command }),
        ),
      ).toThrow("INVALID_COMMAND");
  });
  it("validates protected ticket expiry, role and same-logon server binding", () => {
    const ticket = {
      version: 1,
      owner: { role: "session-agent", nonce: "a".repeat(64), identity: peer },
      server: { ...peer, pid: 60 },
      channel: "b".repeat(64),
      nonce: "c".repeat(64),
      expiresAt: 20000,
    };
    expect(parseSessionTicket(ticket, 10000).server.pid).toBe(60);
    expect(() => parseSessionTicket(ticket, 20000)).toThrow(
      "SESSION_UNAVAILABLE",
    );
    expect(() =>
      parseSessionTicket(
        { ...ticket, owner: { ...ticket.owner, role: "fleet" } },
        10000,
      ),
    ).toThrow("SESSION_UNAVAILABLE");
    expect(() =>
      parseSessionTicket(
        { ...ticket, server: { ...ticket.server, sessionId: 3 } },
        10000,
      ),
    ).toThrow("PEER_DENIED");
  });
  it("forwards actual caller identity to personal submission only after owned personal readiness", async () => {
    const command = vi.fn(async () => ({ personal: { phase: "running" } })),
      personal = vi.fn(async (input) => ({
        version: 1,
        requestId: input.requestId,
        ok: true,
      }));
    const dispatcher = createSessionDispatcher(
      {
        command,
        maintenanceActive: () => false,
        currentAccountScope: () => null,
      } as unknown as SessionSupervisor,
      { command: personal } as unknown as PersonalAgentClient,
      { dispatch: vi.fn() },
    );
    const input = {
      version: 1,
      requestId: randomUUID(),
      action: "submit",
      submission: {
        ownerId: randomUUID(),
        requestId: randomUUID(),
        input: { kind: "youtube", videoId: "abcdefghijk" },
        rightsConfirmed: true,
        recipeId: "kim-vocals-v2",
      },
    };
    await dispatcher.dispatch(
      encode({
        version: 1,
        kind: "personal-command",
        owner_kind: "chrome",
        command: input,
      }),
      peer,
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "personal_attach",
        owner_kind: "chrome",
        owner_id: input.submission.ownerId,
      }),
      peer,
    );
    expect(personal).toHaveBeenCalledWith(input, peer, null);
  });
  it("public personal forwarding cannot call internal guard or account scope controls", async () => {
    const dispatcher = createSessionDispatcher(
      {} as SessionSupervisor,
      {} as PersonalAgentClient,
      { dispatch: vi.fn() },
    );
    for (const command of [
      { action: "stop" },
      { action: "scope", scope: null },
      { action: "guard_status", jobId: randomUUID() },
    ])
      await expect(
        dispatcher.dispatch(
          encode({
            version: 1,
            kind: "personal-command",
            owner_kind: "desktop",
            command: { version: 1, requestId: randomUUID(), ...command },
          }),
          peer,
        ),
      ).rejects.toThrow("PEER_DENIED");
  });
  it.each([
    undefined,
    null,
    { firebaseUid: "A", generation: "00000000-0000-4000-8000-000000000001" },
  ])(
    "the actual session client seals desktop submission authority before transport (capture=%j)",
    async (capture) => {
      const client = new SessionClient({} as WindowsConsumerNative),
        input = {
          version: 1 as const,
          requestId: randomUUID(),
          action: "submit" as const,
          submission: {
            ownerId: randomUUID(),
            requestId: randomUUID(),
            input: { kind: "youtube" as const, videoId: "abcdefghijk" },
            rightsConfirmed: true as const,
            recipeId: "kim-vocals-v2" as const,
          },
        };
      const exchange = vi
        .spyOn(client, "exchange")
        .mockResolvedValue(
          encode({ version: 1, requestId: input.requestId, ok: true }),
        );
      await client.personal(input, "desktop", capture);
      const wire = JSON.parse(
        Buffer.from(exchange.mock.calls[0]![0]).toString(),
      );
      expect(wire.submission_authority).toEqual(
        capture ? { kind: "account", scope: capture } : { kind: "guest" },
      );
      expect(wire.owner_kind).toBe("desktop");
      await expect(
        client.personal(input, "chrome", {
          firebaseUid: "A",
          generation: randomUUID(),
        }),
      ).rejects.toThrow("PEER_DENIED");
    },
  );
  it("preserves an explicit guest capture while login occurs during owned role attachment", async () => {
    let scope: { firebaseUid: string; generation: string } | null = null,
      finish!: () => void;
    const personal = vi.fn(async (input) => ({
      version: 1,
      requestId: input.requestId,
      ok: true,
    }));
    const dispatcher = createSessionDispatcher(
      {
        command: vi.fn(async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { personal: { phase: "running" } };
        }),
        maintenanceActive: () => false,
        currentAccountScope: () => scope,
      } as unknown as SessionSupervisor,
      { command: personal } as unknown as PersonalAgentClient,
      { dispatch: vi.fn() },
    );
    const input = {
      version: 1,
      requestId: randomUUID(),
      action: "submit",
      submission: {
        ownerId: randomUUID(),
        requestId: randomUUID(),
        input: { kind: "youtube", videoId: "abcdefghijk" },
        rightsConfirmed: true,
        recipeId: "kim-vocals-v2",
      },
    };
    const pending = dispatcher.dispatch(
      encode({
        version: 1,
        kind: "personal-command",
        owner_kind: "desktop",
        submission_authority: { kind: "guest" },
        command: input,
      }),
      peer,
    );
    await vi.waitFor(() => expect(finish).toBeDefined());
    scope = { firebaseUid: "A", generation: randomUUID() };
    finish();
    await pending;
    expect(personal).toHaveBeenCalledWith(input, peer, null);
  });
  it("refuses captured account A when B replaces it during attachment instead of issuing a B receipt", async () => {
    const accountA = { firebaseUid: "A", generation: randomUUID() };
    let scope = accountA,
      finish!: () => void;
    const personal = vi.fn();
    const dispatcher = createSessionDispatcher(
      {
        command: vi.fn(async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { personal: { phase: "running" } };
        }),
        maintenanceActive: () => false,
        currentAccountScope: () => scope,
      } as unknown as SessionSupervisor,
      { command: personal } as unknown as PersonalAgentClient,
      { dispatch: vi.fn() },
    );
    const input = {
      version: 1,
      requestId: randomUUID(),
      action: "submit",
      submission: {
        ownerId: randomUUID(),
        requestId: randomUUID(),
        input: { kind: "youtube", videoId: "abcdefghijk" },
        rightsConfirmed: true,
        recipeId: "kim-vocals-v2",
      },
    };
    const pending = dispatcher.dispatch(
      encode({
        version: 1,
        kind: "personal-command",
        owner_kind: "desktop",
        submission_authority: { kind: "account", scope: accountA },
        command: input,
      }),
      peer,
    );
    const refused = expect(pending).rejects.toThrow("SCOPE_CHANGED");
    await vi.waitFor(() => expect(finish).toBeDefined());
    scope = { firebaseUid: "B", generation: randomUUID() };
    finish();
    await refused;
    expect(personal).not.toHaveBeenCalled();
  });
  it("keeps legacy omission compatible but rejects authority substitution and invalid discriminants", async () => {
    const scope = { firebaseUid: "A", generation: randomUUID() },
      personal = vi.fn(async (input) => ({
        version: 1,
        requestId: input.requestId,
        ok: true,
      }));
    const dispatcher = createSessionDispatcher(
      {
        command: vi.fn(async () => ({ personal: { phase: "running" } })),
        maintenanceActive: () => false,
        currentAccountScope: () => scope,
      } as unknown as SessionSupervisor,
      { command: personal } as unknown as PersonalAgentClient,
      { dispatch: vi.fn() },
    );
    const input = {
        version: 1,
        requestId: randomUUID(),
        action: "submit",
        submission: {
          ownerId: randomUUID(),
          requestId: randomUUID(),
          input: { kind: "youtube", videoId: "abcdefghijk" },
          rightsConfirmed: true,
          recipeId: "kim-vocals-v2",
        },
      },
      base = {
        version: 1,
        kind: "personal-command",
        owner_kind: "desktop",
        command: input,
      };
    await dispatcher.dispatch(encode(base), peer);
    expect(personal).toHaveBeenCalledWith(input, peer, scope);
    for (const authority of [
      null,
      { kind: "guest", scope },
      { kind: "account", scope: null },
      { kind: "account", scope: { ...scope, generation: "old" } },
      { kind: "guest", token: "secret" },
    ])
      await expect(
        dispatcher.dispatch(
          encode({ ...base, submission_authority: authority }),
          peer,
        ),
      ).rejects.toThrow();
    await expect(
      dispatcher.dispatch(
        encode({
          ...base,
          owner_kind: "chrome",
          submission_authority: { kind: "account", scope },
        }),
        peer,
      ),
    ).rejects.toThrow("PEER_DENIED");
    await expect(
      dispatcher.dispatch(
        encode({
          ...base,
          command: {
            version: 1,
            requestId: randomUUID(),
            action: "jobs",
            ownerId: input.submission.ownerId,
          },
          submission_authority: { kind: "guest" },
        }),
        peer,
      ),
    ).rejects.toThrow("INVALID_COMMAND");
  });
  it("routes GPU frames through their authenticated dispatcher without session command mutation", async () => {
    const gpu = { dispatch: vi.fn(async () => Buffer.from("proof")) },
      session = { command: vi.fn() };
    const dispatcher = createSessionDispatcher(
      session as unknown as SessionSupervisor,
      {} as PersonalAgentClient,
      gpu,
    );
    const bytes = encode({
      version: 1,
      kind: "gpu-admission",
      action: "status",
    });
    expect((await dispatcher.dispatch(bytes, peer)).toString()).toBe("proof");
    expect(gpu.dispatch).toHaveBeenCalledWith(bytes, peer);
    expect(session.command).not.toHaveBeenCalled();
  });
  it("session bootstrap rejects missing signed small-file inventory and root substitution", () => {
    const personalRoot = "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal",
      release = "a".repeat(64),
      hash = "b".repeat(64);
    const configuration = {
      version: 1,
      kind: "session-agent",
      installationProfile: "windows-user",
      release,
      releaseRoot: personalRoot + "\\runtime\\releases\\" + release,
      nativeSha256: hash,
      personalRoot,
      fleetRoot: "C:\\Users\\fixture\\AppData\\Local\\MusicMuteWorker",
      launchFiles: Object.fromEntries(
        [
          "runtime/node/node.exe",
          "runtime/native/musicmute-native.exe",
          "agent/session-agent.cjs",
          "agent/personal.cjs",
          "agent/fleet.cjs",
        ].map((path) => [path, hash]),
      ),
    };
    expect(parseSessionAgentConfiguration(configuration).release).toBe(release);
    expect(() =>
      parseSessionAgentConfiguration({ ...configuration, launchFiles: {} }),
    ).toThrow("SESSION_CONFIG_INVALID");
    expect(() =>
      parseSessionAgentConfiguration({
        ...configuration,
        releaseRoot: "C:\\outside",
      }),
    ).toThrow("SESSION_CONFIG_INVALID");
  });
});
