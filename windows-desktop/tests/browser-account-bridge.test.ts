import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserAccountClient,
  BrowserAccountCleanupUnconfirmed,
  parseBrowserAccountTicket,
  serveBrowserAccountAuthority,
} from "../src/main/browser/account-bridge.js";
import type { BrowserAccountAuthority } from "../src/main/browser/account-authority.js";
import type { BrowserAccountState } from "../src/main/browser/account-contracts.js";
import type { WindowsConsumerNative } from "../../worker/src/platform/windows/consumer-native.js";
import { StoreAccountNative } from "../src/main/browser/store-account-native.js";
it("does not turn an injected Store-shaped account port into live authority or a legacy fallback", async () => {
  const readTicket = vi.fn(async () => ticket()),
    launch = vi.fn(async () => owner),
    publication = vi.fn(async () => {}),
    openNative = vi.fn();
  const forged = Object.assign(Object.create(StoreAccountNative.prototype), {
    readTicket,
    launchAccountAuthority: launch,
    assertSingletonPublication: publication,
  }) as StoreAccountNative;
  const client = new BrowserAccountClient(forged, undefined);
  expect(await client.healthy()).toBe(false);
  await expect(client.connect()).rejects.toThrow();
  await expect(
    serveBrowserAccountAuthority(
      { kind: "store", native: forged, openNative },
      {} as BrowserAccountAuthority,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(readTicket).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
  expect(publication).not.toHaveBeenCalled();
  expect(openNative).not.toHaveBeenCalled();
  expect(() => new BrowserAccountClient(forged, pin)).toThrow(
    "STORE_ACCOUNT_DENIED",
  );
  expect(
    () => new BrowserAccountClient({} as WindowsConsumerNative, undefined),
  ).toThrow("STORE_ACCOUNT_DENIED");
});
const peer = {
    pid: 50,
    creationTime: "133400000000000001",
    sid: "S-1-5-21-1-2-3-1001",
    sessionId: 1,
  },
  owner = { ...peer, pid: 60 },
  server = { ...peer, pid: 70 },
  pin = { sha256: "a".repeat(64), bytes: 64, publisherSha256: "b".repeat(64) };
const state: BrowserAccountState = {
  version: 1,
  instance_id: randomUUID(),
  revision: 1,
  unchanged: false,
  job: null,
  selection: {
    processing_provider: "LOCAL_WINDOWS",
    processing_scope: null,
    cloud_ready: false,
    error_code: null,
    cache_reuse_supported: false,
    publication_supported: false,
  },
};
function ticket(index = 1) {
  return {
    version: 1,
    owner,
    server,
    instance_id: state.instance_id,
    channel: index.toString(16).padStart(64, "0"),
    nonce: (index + 100).toString(16).padStart(64, "0"),
    expires_at: Date.now() + 30000,
  };
}
function clientFixture() {
  let current = ticket(),
    index = 1,
    waitComplete: ((value: Buffer) => void) | undefined;
  const consumed = new Set<string>(),
    calls: Record<string, unknown>[] = [],
    close = vi.fn(async () => {}),
    launchAccountAuthority = vi.fn(async () => owner),
    verifyAccountPeer = vi.fn(async () => true),
    processIdentity = vi.fn(async (pid: number) => ({ ...peer, pid }));
  const native = {
    identity: vi.fn(async () => peer),
    vaultRead: vi.fn(async (): Promise<Buffer | null> => {
      if (consumed.has(current.nonce)) current = ticket(++index);
      return Buffer.from(JSON.stringify(current));
    }),
    processIdentity,
    sameParentProcess: vi.fn(async () => true),
    verifyAccountPeer,
    launchAccountAuthority,
    claimBrowserAccountTicket: vi.fn(async (nonce: string) => {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    }),
    pipeConnect: vi.fn(async (input: { payload: Buffer; nonce: string }) => {
      const body = JSON.parse(input.payload.toString());
      calls.push(body);
      const command = body.command,
        reply = Buffer.from(
          JSON.stringify({
            version: 1,
            request_id: command.request_id,
            ok: true,
            state,
          }),
        );
      if (command.action === "wait")
        return new Promise<Buffer>((resolve) => {
          waitComplete = () => resolve(reply);
        });
      return reply;
    }),
    close,
  };
  const eventNative = {
      ...native,
      identity: vi.fn(async () => ({ ...peer, pid: 51 })),
      close: vi.fn(async () => {}),
    },
    client = new BrowserAccountClient(
      native as unknown as WindowsConsumerNative,
      pin,
      async () => eventNative as unknown as WindowsConsumerNative,
    );
  return {
    client,
    native,
    eventNative,
    calls,
    consumed,
    completeWait: () => waitComplete?.(Buffer.alloc(0)),
    setTicket: (row: ReturnType<typeof ticket>) => {
      current = row;
    },
    state,
  };
}
describe("private Windows browser account transport", () => {
  it("validates bounded expiry/version and same-user logon listener identities", () => {
    const row = ticket();
    expect(parseBrowserAccountTicket(row).nonce).toBe(row.nonce);
    for (const value of [
      { ...row, expires_at: Date.now() - 1 },
      { ...row, expires_at: Date.now() + 36000 },
      { ...row, version: 2 },
      { ...row, server: { ...server, sessionId: 2 } },
      { ...row, extra: "token" },
    ])
      expect(() => parseBrowserAccountTicket(value)).toThrow();
  });
  it("cold-connects through fixed pinned app authority only when no live authenticated ticket exists", async () => {
    const f = clientFixture();
    f.native.vaultRead.mockResolvedValueOnce(null);
    expect(await f.client.connect()).toEqual(state);
    expect(f.native.launchAccountAuthority).toHaveBeenCalledWith(pin);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.command).toMatchObject({ action: "selection" });
    expect(JSON.stringify(f.calls)).not.toMatch(
      /id_token|refresh_token|publisher|sha256/u,
    );
    await f.client.close();
  });
  it("never treats a matching SID or stale PID alone as healthy authority", async () => {
    const f = clientFixture();
    f.native.verifyAccountPeer.mockResolvedValue(false);
    expect(await f.client.healthy()).toBe(false);
    expect(f.native.pipeConnect).not.toHaveBeenCalled();
    f.native.verifyAccountPeer.mockResolvedValue(true);
    f.native.processIdentity.mockImplementation(async (pid: number) => ({
      ...peer,
      pid,
      creationTime: "133400000000000099",
    }));
    expect(await f.client.healthy()).toBe(false);
    expect(f.native.pipeConnect).not.toHaveBeenCalled();
  });
  it("claims each ticket once under concurrent commands without serializing response lifetime", async () => {
    const f = clientFixture();
    await Promise.all([
      f.client.command({ action: "status" }),
      f.client.command({ action: "status" }),
    ]);
    expect(f.calls).toHaveLength(2);
    const nonces = f.native.pipeConnect.mock.calls.map(
      ([input]) => input.nonce,
    );
    expect(new Set(nonces).size).toBe(2);
    await f.client.close();
  });
  it("keeps a long event wait on a separate helper while control cancel remains responsive and original peer stable", async () => {
    const f = clientFixture(),
      waiting = f.client.wait(1, state.instance_id);
    await vi.waitFor(() =>
      expect(f.calls[0]?.command).toMatchObject({ action: "wait" }),
    );
    await f.client.command({ action: "cancel", job_id: randomUUID() });
    expect(f.calls[1]?.command).toMatchObject({ action: "cancel" });
    expect(f.calls[0]?.original_peer).toEqual(peer);
    f.completeWait();
    await waiting;
    await f.client.close();
    expect(f.eventNative.close).toHaveBeenCalledOnce();
    expect(f.native.close).not.toHaveBeenCalled();
  });
  it("never retries a paid START after an ambiguous pipe response", async () => {
    const f = clientFixture();
    f.native.pipeConnect.mockRejectedValueOnce(new Error("PIPE_UNAVAILABLE"));
    await expect(
      f.client.start("bZxrIoCPsOc", 60, "a".repeat(64), randomUUID()),
    ).rejects.toThrow("PIPE_UNAVAILABLE");
    expect(f.native.pipeConnect).toHaveBeenCalledOnce();
    expect(f.native.launchAccountAuthority).not.toHaveBeenCalled();
  });
  it("rejects duplicate-key replies without returning an authority snapshot", async () => {
    const f = clientFixture();
    f.native.pipeConnect.mockImplementationOnce(async (input) =>
      Buffer.from(
        JSON.stringify({
          version: 1,
          request_id: JSON.parse(input.payload.toString()).command.request_id,
          ok: true,
          state,
        }).replace('"ok":true', '"ok":false,"ok":true'),
      ),
    );
    await expect(f.client.command({ action: "status" })).rejects.toThrow(
      "INVALID_JSON",
    );
  });
});
async function serverFixture(payload: Buffer, sameParent = true) {
  const abort = new AbortController(),
    execute = vi.fn(async (command) => ({
      version: 1,
      request_id: command.request_id,
      ok: true,
      state,
    })),
    holdReply = vi.fn(() => vi.fn()),
    native = {
      identity: async () => owner,
      assertSingletonPublication: vi.fn(async () => {}),
      vaultWrite: vi.fn(async () => {}),
      vaultRead: async () => null,
      sameParentProcess: vi.fn(async () => sameParent),
    },
    accepted = {
      payload,
      connection: { peer, capability: "a".repeat(64), nonce: "b".repeat(64) },
    };
  let count = 0;
  const listeners: {
      pipeAccept: ReturnType<typeof vi.fn>;
      pipeReply: ReturnType<typeof vi.fn>;
      pipeClose: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      identity: () => Promise<typeof server>;
    }[] = [],
    openNative = async () => {
      let reject: ((error: Error) => void) | undefined;
      const first = count++ === 0,
        row = {
          identity: async () => server,
          pipeAccept: vi.fn(async () =>
            first
              ? accepted
              : new Promise<typeof accepted>((_, r) => {
                  reject = r;
                }),
          ),
          pipeReply: vi.fn(async () => {
            abort.abort();
          }),
          pipeClose: vi.fn(async () => {
            abort.abort();
          }),
          close: vi.fn(async () => {
            reject?.(new Error("PIPE_TIMEOUT"));
          }),
        };
      listeners.push(row);
      return row as unknown as WindowsConsumerNative;
    };
  await serveBrowserAccountAuthority(
    { native: native as unknown as WindowsConsumerNative, openNative },
    {
      instanceId: state.instance_id,
      execute,
      holdReply,
    } as unknown as BrowserAccountAuthority,
    abort.signal,
  );
  return { execute, holdReply, native, listeners };
}
describe("dynamic account dispatch authenticated event/publication lanes", () => {
  const command = {
    version: 1,
    owner_id: randomUUID(),
    request_id: randomUUID(),
    action: "status",
  };
  it("joins the original listener retirement after abort before removing its ticket", async () => {
    const abort = new AbortController();
    let rejectAccept!: (error: Error) => void,
      completeRetirement!: () => void,
      settled = false;
    const close = vi.fn(() => {
        rejectAccept(new Error("PIPE_TIMEOUT"));
        return new Promise<void>((resolve) => {
          completeRetirement = resolve;
        });
      }),
      vaultRead = vi.fn(async () => null),
      native = {
        identity: async () => owner,
        assertSingletonPublication: async () => {},
        vaultWrite: async () => {},
        vaultRead,
      },
      listener = {
        identity: async () => server,
        pipeAccept: vi.fn(
          () =>
            new Promise<never>((_, reject) => {
              rejectAccept = reject;
            }),
        ),
        close,
      },
      serving = serveBrowserAccountAuthority(
        {
          native: native as unknown as WindowsConsumerNative,
          openNative: async () => listener as unknown as WindowsConsumerNative,
        },
        { instanceId: state.instance_id } as BrowserAccountAuthority,
        abort.signal,
      ).finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(listener.pipeAccept).toHaveBeenCalledOnce());
    abort.abort();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(vaultRead).not.toHaveBeenCalled();
    completeRetirement();
    await serving;
    expect(close).toHaveBeenCalledOnce();
    expect(vaultRead).toHaveBeenCalledOnce();
  });
  it("retains the reply hold and ticket when an aborted accepted helper cannot confirm retirement", async () => {
    const abort = new AbortController(),
      release = vi.fn(),
      vaultRead = vi.fn(async () => null),
      native = {
        identity: async () => owner,
        assertSingletonPublication: async () => {},
        vaultWrite: async () => {},
        vaultRead,
      },
      listener = {
        identity: async () => server,
        pipeAccept: async () => ({
          payload: Buffer.from(
            JSON.stringify({ version: 1, kind: "browser-account", command }),
          ),
          connection: {
            peer,
            capability: "a".repeat(64),
            nonce: "b".repeat(64),
          },
        }),
        pipeReply: async () => {
          abort.abort();
        },
        pipeClose: async () => {},
        close: vi.fn(async () => {
          throw new Error("JOB_EXIT_UNCONFIRMED");
        }),
      },
      serving = serveBrowserAccountAuthority(
        {
          native: native as unknown as WindowsConsumerNative,
          openNative: async () => listener as unknown as WindowsConsumerNative,
        },
        {
          instanceId: state.instance_id,
          holdReply: () => release,
          execute: async () => ({ version: 1, ok: true, state }),
        } as unknown as BrowserAccountAuthority,
        abort.signal,
      );
    await expect(serving).rejects.toBeInstanceOf(
      BrowserAccountCleanupUnconfirmed,
    );
    expect(listener.close).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(vaultRead).not.toHaveBeenCalled();
  });
  it("executes request before publishing its dynamic reply and releases the ACK hold", async () => {
    const f = await serverFixture(
      Buffer.from(
        JSON.stringify({ version: 1, kind: "browser-account", command }),
      ),
    );
    expect(f.execute).toHaveBeenCalledWith(
      command,
      peer,
      undefined,
      expect.any(AbortSignal),
    );
    // Transport shutdown propagates to explicit CHECK ownership, not just its reply.
    expect(
      (
        f.execute.mock.calls[0] as unknown as [
          unknown,
          unknown,
          unknown,
          AbortSignal,
        ]
      )[3].aborted,
    ).toBe(true);
    expect(f.listeners[0]?.pipeReply).toHaveBeenCalledOnce();
    expect(f.holdReply.mock.results[0]?.value).toHaveBeenCalledOnce();
  });
  it.each(["duplicate", "unknown", "foreign-event", "foreign-publication"])(
    "denies %s frame before executing any authority command",
    async (kind) => {
      let envelope: Record<string, unknown> = {
        version: 1,
        kind: "browser-account",
        command,
      };
      if (kind === "unknown") envelope.token = "secret";
      if (kind === "foreign-event")
        envelope = {
          ...envelope,
          command: { ...command, action: "wait", after_revision: 0 },
          original_peer: { ...peer, pid: 52 },
        };
      if (kind === "foreign-publication")
        envelope = {
          ...envelope,
          command: {
            ...command,
            action: "playback_started",
            video_id: "bZxrIoCPsOc",
            job_id: randomUUID(),
          },
          publication_peer: { ...peer, pid: 52 },
        };
      let text = JSON.stringify(envelope);
      if (kind === "duplicate")
        text = text.replace('"version":1', '"version":1,"version":1');
      const f = await serverFixture(Buffer.from(text), false);
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.listeners[0]?.pipeClose).toHaveBeenCalledOnce();
    },
  );
});
