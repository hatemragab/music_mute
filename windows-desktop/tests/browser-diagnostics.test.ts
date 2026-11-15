import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BrowserAccountAuthority } from "../src/main/browser/account-authority.js";
import { BrowserAccountClient } from "../src/main/browser/account-bridge.js";
import { WindowsBrowserService } from "../src/main/browser/service.js";
import {
  parseBrowserAccountCommand,
  type BrowserAccountAuthorityOptions,
} from "../src/main/browser/account-contracts.js";
import type { WindowsConsumerNative } from "../../worker/src/platform/windows/consumer-native.js";
import type { NativeReply } from "../../chrome-extension/src/shared/protocol.js";
import { chromeReport } from "./chrome-diagnostics-fixtures.js";
import { accountView } from "./fleet-fixtures.js";
const peer = {
  pid: 50,
  creationTime: "133400000000000001",
  sid: "S-1-5-21-1-2-3-1001",
  sessionId: 1,
};
const request = (ownerId = randomUUID()) => ({
  version: 1,
  request_id: randomUUID(),
  owner_id: ownerId,
  action: "diagnostics",
});
function authorityFixture() {
  let allowed = true;
  const exportReport = vi.fn(async () => ({
      report: chromeReport(),
      receipt: randomUUID(),
    })),
    authorization = vi.fn(async () => {
      throw new Error("unexpected authorization");
    }),
    fetch = vi.fn(async () => {
      throw new Error("unexpected network");
    }),
    read = vi.fn(async () => {
      throw new Error("unexpected mode read");
    }),
    publish = vi.fn(async () => {
      throw new Error("unexpected media grant");
    }),
    verifyPeer = vi.fn(async () => true);
  const options: BrowserAccountAuthorityOptions = {
    origin: null,
    installationId: randomUUID(),
    selectedMode: () => "local",
    consumersAllowed: () => allowed,
    account: {
      view: () => accountView(),
      sessionScope: () => null,
      assertScope: () => {
        throw new Error("unexpected account scope");
      },
      authorization,
      subscribe: () => () => {},
    },
    usage: {
      view: () => ({
        connection: "stopped",
        authenticated: false,
        libraryReady: false,
        usageState: "unavailable",
        usage: null,
        policyState: "unavailable",
        policy: null,
        errorCode: null,
      }),
      assertCloudSubmission: () => {
        throw new Error("unexpected cloud policy");
      },
      subscribe: () => () => {},
    },
    realtime: {
      cloudLease: () => {
        throw new Error("unexpected realtime");
      },
    },
    modeStore: { read, write: async () => {} },
    media: { publish },
    verifyPeer,
    fetch,
    diagnostics: { exportReport },
  };
  return {
    authority: new BrowserAccountAuthority(options),
    options,
    exportReport,
    authorization,
    fetch,
    read,
    publish,
    verifyPeer,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
  };
}
it("personal diagnostics remains available signed out and cold without cloud, model or worker authority", async () => {
  const f = authorityFixture(),
    command = request(),
    reply = await f.authority.diagnostics(
      command,
      peer,
      new AbortController().signal,
    );
  expect(reply).toMatchObject({
    ok: true,
    request_id: command.request_id,
    diagnostics: { report: { availability: "no-logs" } },
  });
  expect(f.exportReport).toHaveBeenCalledWith(
    command.request_id,
    expect.any(AbortSignal),
  );
  for (const call of [f.authorization, f.fetch, f.read, f.publish])
    expect(call).not.toHaveBeenCalled();
  await f.authority.dispose();
});
it("denies maintenance, unverified or replaced peers, and never interprets diagnostic payload as worker actions", async () => {
  const f = authorityFixture(),
    command = request();
  f.setAllowed(false);
  expect(
    await f.authority.diagnostics(command, peer, new AbortController().signal),
  ).toMatchObject({ ok: false, error_code: "PROCESSING_MAINTENANCE" });
  expect(f.exportReport).not.toHaveBeenCalled();
  f.setAllowed(true);
  f.verifyPeer.mockResolvedValueOnce(false);
  expect(
    await f.authority.diagnostics(command, peer, new AbortController().signal),
  ).toMatchObject({ ok: false, error_code: "PEER_DENIED" });
  expect(
    (await f.authority.diagnostics(command, peer, new AbortController().signal))
      .ok,
  ).toBe(true);
  expect(
    await f.authority.diagnostics(
      { ...command, request_id: randomUUID() },
      { ...peer, creationTime: "133400000000000099" },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, error_code: "PEER_DENIED" });
  for (const fields of [
    { path: "C:\\private" },
    { full: true },
    { fleet: true },
    { action: "clear" },
    { action: "doctor" },
  ])
    expect(() => parseBrowserAccountCommand({ ...command, ...fields })).toThrow(
      "INVALID_COMMAND",
    );
  await f.authority.dispose();
});
it("retains activity through real pending report teardown and suppresses late replies after owner detach", async () => {
  const f = authorityFixture(),
    command = request();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.exportReport.mockImplementationOnce(async () => {
    await held;
    return { report: chromeReport(), receipt: randomUUID() };
  });
  const task = f.authority.diagnostics(
    command,
    peer,
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(f.exportReport).toHaveBeenCalledOnce());
  let closed = false;
  const close = f.authority.dispose().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(f.authority.activity().idle).toBe(false);
  finish();
  expect(await task).toMatchObject({ ok: false, error_code: "PEER_DENIED" });
  await close;
  expect(f.authority.activity().idle).toBe(true);
});
it("invalid report fields and private failures produce bounded error codes rather than raw data", async () => {
  const f = authorityFixture();
  f.exportReport.mockResolvedValueOnce({
    report: { ...chromeReport(), path: "C:\\private" },
    receipt: randomUUID(),
  } as never);
  expect(
    await f.authority.diagnostics(
      request(),
      peer,
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, error_code: "DIAGNOSTICS_REPORT_INVALID" });
  f.exportReport.mockRejectedValueOnce(new Error("C:\\private?token=secret"));
  expect(
    await f.authority.diagnostics(
      request(),
      peer,
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, error_code: "ACCOUNT_SESSION_UNAVAILABLE" });
  await f.authority.dispose();
});
function clientFixture() {
  const owner = { ...peer, pid: 60 },
    server = { ...peer, pid: 70 },
    instance = randomUUID();
  let sequence = 0;
  const report = { report: chromeReport(), receipt: randomUUID() },
    calls: Record<string, unknown>[] = [],
    native = {
      identity: async () => peer,
      vaultRead: async () =>
        Buffer.from(
          JSON.stringify({
            version: 1,
            owner,
            server,
            instance_id: instance,
            channel: (++sequence).toString(16).padStart(64, "0"),
            nonce: (sequence + 100).toString(16).padStart(64, "0"),
            expires_at: Date.now() + 30000,
          }),
        ),
      processIdentity: async (pid: number) => ({ ...peer, pid }),
      sameParentProcess: async () => true,
      verifyAccountPeer: async () => true,
      claimBrowserAccountTicket: async () => true,
      pipeConnect: vi.fn(async (input: { payload: Buffer }) => {
        const envelope = JSON.parse(input.payload.toString());
        calls.push(envelope);
        return Buffer.from(
          JSON.stringify({
            version: 1,
            request_id: envelope.command.request_id,
            ok: true,
            diagnostics: report,
          }),
        );
      }),
    };
  const client = new BrowserAccountClient(
    native as unknown as WindowsConsumerNative,
    { sha256: "a".repeat(64), bytes: 64, publisherSha256: "b".repeat(64) },
  );
  return { client, native, report, calls };
}
it("the authenticated private pipe preserves public request UUIDs and rejects oversized/mismatched/wrong-lane replies", async () => {
  const f = clientFixture(),
    requestId = randomUUID();
  expect(await f.client.diagnostics(requestId)).toEqual(f.report);
  expect(f.calls[0]).toMatchObject({
    kind: "browser-account",
    command: {
      action: "diagnostics",
      request_id: requestId,
      owner_id: f.client.ownerId,
    },
  });
  await expect(f.client.command({ action: "diagnostics" })).rejects.toThrow(
    "INVALID_COMMAND",
  );
  f.native.pipeConnect.mockResolvedValueOnce(Buffer.alloc(32769));
  await expect(f.client.diagnostics(randomUUID())).rejects.toThrow(
    "ACCOUNT_SESSION_UNAVAILABLE",
  );
  f.native.pipeConnect.mockResolvedValueOnce(
    Buffer.from(
      JSON.stringify({
        version: 1,
        request_id: randomUUID(),
        ok: true,
        diagnostics: f.report,
      }),
    ),
  );
  await expect(f.client.diagnostics(randomUUID())).rejects.toThrow(
    "ACCOUNT_SESSION_UNAVAILABLE",
  );
  f.native.pipeConnect.mockImplementationOnce(async (input) => {
    const command = JSON.parse(input.payload.toString()).command;
    return Buffer.from(
      JSON.stringify({
        version: 1,
        request_id: command.request_id,
        ok: true,
        state: {},
      }),
    );
  });
  await expect(f.client.diagnostics(randomUUID())).rejects.toThrow(
    "ACCOUNT_SESSION_UNAVAILABLE",
  );
});
it("the Chrome gateway returns compatible REPORT with no private path, receipt or local session startup", async () => {
  const writes: NativeReply[] = [],
    getSession = vi.fn(async () => {
      throw new Error("unexpected Prepare");
    }),
    diagnostics = vi.fn(async () => ({
      report: chromeReport(),
      receipt: randomUUID(),
    })),
    account = {
      ownerId: randomUUID(),
      command: vi.fn(),
      start: vi.fn(),
      wait: vi.fn(),
      playbackStarted: vi.fn(),
      close: vi.fn(async () => {}),
      diagnostics,
    },
    media = { issue: vi.fn(), close: vi.fn(async () => {}) },
    service = new WindowsBrowserService({
      account,
      getSession,
      media,
      write: async (value) => {
        writes.push(value);
      },
      onDisconnected: vi.fn(),
    }),
    id = randomUUID(),
    command = {
      protocol_version: 1,
      request_id: id,
      type: "DIAGNOSTICS",
      payload: {},
    };
  await service.command(command);
  expect(writes).toEqual([
    {
      protocol_version: 1,
      request_id: id,
      type: "REPORT",
      payload: { report: chromeReport() },
    },
  ]);
  expect(diagnostics).toHaveBeenCalledWith(id);
  expect(getSession).not.toHaveBeenCalled();
  expect(account.command).not.toHaveBeenCalled();
  expect(media.issue).not.toHaveBeenCalled();
  diagnostics.mockRejectedValueOnce(new Error("DIAGNOSTICS_BUSY"));
  await service.command({ ...command, request_id: randomUUID() });
  expect(writes.at(-1)).toMatchObject({
    type: "ERROR",
    payload: { error_code: "DIAGNOSTICS_BUSY" },
  });
  await expect(
    service.command({ ...command, payload: { path: "C:\\private" } }),
  ).rejects.toThrow("INVALID_COMMAND");
  await service.close();
});
