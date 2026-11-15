import { beforeEach, describe, expect, it, vi } from "vitest";
import { processIdentityToWire } from "../../worker/src/platform/windows/consumer-native-policy.js";
import { ConsumerNativeError } from "../../worker/src/platform/windows/consumer-native.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import {
  BrowserAccountCleanupUnconfirmed,
  serveBrowserAccountAuthority,
} from "../src/main/browser/account-bridge.js";
import type { BrowserAccountAuthority } from "../src/main/browser/account-authority.js";
import type {
  StoreBootReceipt,
  StoreNativeAuthority,
} from "../src/main/browser/store-native.js";

// Test-only sealed-class stand-in with real private fields. This exercises the
// production port/parser behavior, never actual Microsoft Store/OS authority.
const fixture = vi.hoisted(() => ({
  request:
    vi.fn<(operation: string, args: Record<string, unknown>) => unknown>(),
  close: vi.fn(),
}));
vi.mock("../src/main/browser/store-native.js", () => ({
  StoreNativeAuthority: class {
    readonly receipt: StoreBootReceipt;
    #closed = false;
    constructor(receipt: StoreBootReceipt) {
      this.receipt = receipt;
    }
    creatorProof() {
      if (this.#closed) throw new Error("FIXTURE_AUTHORITY_CLOSED");
      return {
        version: 1,
        gui: this.receipt.parent,
        helper: this.receipt.helper,
        packageFullName: this.receipt.package.fullName,
      };
    }
    accountOperation(operation: string, args: Record<string, unknown>) {
      if (this.#closed) throw new Error("FIXTURE_AUTHORITY_CLOSED");
      return fixture.request(operation, args);
    }
    close() {
      this.#closed = true;
      return fixture.close();
    }
  },
}));
import { StoreNativeAuthority as NativeFixture } from "../src/main/browser/store-native.js";
import {
  StoreAccountNative,
  openStoreAccountNative,
  parseStoreAccountInput,
  parseStoreAccountResult,
  parseStoreAccountTicket,
  type StoreAccountOperation,
} from "../src/main/browser/store-account-native.js";

const sid = "S-1-5-21-1-2-3-1001",
  now = 1_800_000_000_000;
const instance = "a1234567-1234-4123-8123-123456789abc";
const identity = (pid: number) => ({
  sid,
  sessionId: 1,
  pid,
  creationTime: "1337133713371337",
});
function receipt(): StoreBootReceipt {
  const product = STORE_PRODUCTS.gui,
    fullName = `${product.identityName}_0.1.0.2_x64__${product.publisherId}`;
  return {
    version: 1,
    package: {
      ...product,
      fullName,
      packageVersion: "0.1.0.2",
      architecture: "x64",
      signatureKind: 3,
      healthy: true,
      current: true,
      installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
    },
    helper: identity(43),
    parent: identity(41),
    logonSid: "S-1-5-5-1-42",
  };
}
function canonicalReceipt(): StoreBootReceipt {
  const value = receipt(),
    {
      identityName,
      publisher,
      publisherId,
      familyName,
      fullName,
      packageVersion,
      architecture,
      signatureKind,
      healthy,
      current,
      installedLocation,
    } = value.package;
  return {
    ...value,
    package: {
      identityName,
      publisher,
      publisherId,
      familyName,
      fullName,
      packageVersion,
      architecture,
      signatureKind,
      healthy,
      current,
      installedLocation,
    },
  };
}
function ticket(expiry = Date.now() + 30_000) {
  return {
    version: 2,
    owner: processIdentityToWire(identity(42)),
    server: processIdentityToWire(identity(43)),
    gui: processIdentityToWire(identity(41)),
    instance_id: instance,
    channel: "a".repeat(64),
    nonce: "b".repeat(64),
    expires_at: expiry,
    lease_nonce: "c".repeat(64),
    package_full_name: receipt().package.fullName,
  };
}
function authority(helperPid = 43) {
  return Reflect.construct(NativeFixture, [
    { ...canonicalReceipt(), helper: identity(helperPid) },
  ]) as StoreNativeAuthority;
}
beforeEach(() => {
  fixture.request.mockReset();
  fixture.close.mockReset();
});

describe("Store account receiving grammar (parsed values are not authority)", () => {
  it("parses current v2 ticket and preserves existing business fields", () => {
    const parsed = parseStoreAccountTicket(
      ticket(now + 30_000),
      canonicalReceipt(),
      now,
    );
    expect(parsed.version).toBe(2);
    expect(parsed.owner.pid).toBe(42);
    expect(parsed.server.pid).toBe(43);
    expect(parsed.gui.pid).toBe(41);
    expect(parsed.packageFullName).toBe(receipt().package.fullName);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed).not.toHaveProperty("pipeConnect");
  });
  it.each([
    { version: 1 },
    { nonce: "A".repeat(64) },
    { expires_at: now },
    { expires_at: now + 35_001 },
    { package_full_name: "foreign" },
    { owner: processIdentityToWire(identity(43)) },
    { gui: processIdentityToWire({ ...identity(41), sessionId: 2 }) },
    { allow_unsigned: true },
  ])("rejects stale, foreign or self-authorizing ticket %j", (change) => {
    expect(() =>
      parseStoreAccountTicket(
        { ...ticket(now + 30_000), ...change },
        canonicalReceipt(),
        now,
      ),
    ).toThrow("STORE_ACCOUNT_DENIED");
  });
  it.each([0, 1, 2, 4])(
    "rejects receipt signature kind %i",
    (signatureKind) => {
      const value = canonicalReceipt();
      expect(() =>
        parseStoreAccountTicket(
          ticket(now + 30_000),
          {
            ...value,
            package: { ...value.package, signatureKind },
          } as StoreBootReceipt,
          now,
        ),
      ).toThrow("STORE_ACCOUNT_DENIED");
    },
  );
  it("rejects accessor/prototype/symbol fields without invoking the accessor", () => {
    const getter = vi.fn(() => 2),
      value = ticket(now + 30_000);
    Object.defineProperty(value, "version", { get: getter, enumerable: true });
    expect(() =>
      parseStoreAccountTicket(value, canonicalReceipt(), now),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      parseStoreAccountInput(
        "store_account_launch",
        Object.assign(Object.create({}), {}),
      ),
    ).toThrow();
    expect(() =>
      parseStoreAccountInput("store_account_launch", {
        [Symbol("caller")]: true,
      }),
    ).toThrow();
  });
  it.each([
    "pipe_connect",
    "launch_account_authority",
    "store_account_execute",
    "STORE_ACCOUNT_LAUNCH",
  ])("rejects operation %s", (operation) => {
    expect(() =>
      parseStoreAccountInput(operation as StoreAccountOperation, {}),
    ).toThrow();
  });
  it("admits only fixed no-options activation with ACK semantics", () => {
    expect(parseStoreAccountInput("store_account_launch", {})).toEqual({});
    for (const value of [
      { path: "C:/caller.exe" },
      { aumid: "caller" },
      { arguments: "--cmd" },
      { allow_unsigned: true },
    ])
      expect(() =>
        parseStoreAccountInput("store_account_launch", value),
      ).toThrow();
    const response = {
      version: 1,
      activation: "acknowledged",
      pid: 45,
      aumid: STORE_PRODUCTS.gui.familyName + "!MusicMute",
    };
    expect(
      parseStoreAccountResult(
        "store_account_launch",
        response,
        canonicalReceipt(),
      ),
    ).toEqual(response);
    expect(() =>
      parseStoreAccountResult(
        "store_account_launch",
        { ...response, authorized: true },
        canonicalReceipt(),
      ),
    ).toThrow();
    expect(() =>
      parseStoreAccountResult(
        "store_account_launch",
        { ...response, aumid: "foreign!App" },
        canonicalReceipt(),
      ),
    ).toThrow();
  });
  it("validates framed payload and deadline bounds", () => {
    const value = {
      channel: "a".repeat(64),
      nonce: "b".repeat(64),
      peer: processIdentityToWire(identity(42)),
      payload_base64: Buffer.from("مرحبا 🎵").toString("base64"),
      timeout_ms: 30_000,
    };
    expect(
      parseStoreAccountInput("store_account_pipe_connect", value)
        .payload_base64,
    ).toBe(value.payload_base64);
    for (const change of [
      { timeout_ms: 30_001 },
      { timeout_ms: 99 },
      { payload_base64: "AB==" },
      { payload_base64: Buffer.alloc(4097).toString("base64") },
      { creator: true },
    ])
      expect(() =>
        parseStoreAccountInput("store_account_pipe_connect", {
          ...value,
          ...change,
        }),
      ).toThrow();
    expect(() =>
      parseStoreAccountResult(
        "store_account_pipe_accept",
        {
          version: 1,
          connection: {
            token: "c".repeat(64),
            nonce: "b".repeat(64),
            peer: processIdentityToWire(identity(42)),
          },
          payload_base64: Buffer.alloc(4097).toString("base64"),
        },
        canonicalReceipt(),
      ),
    ).toThrow();
  });
  it("ties owner binding to actual boot helper and GUI", () => {
    const value = {
      version: 1,
      bound: true,
      owner: processIdentityToWire(identity(43)),
      gui: processIdentityToWire(identity(41)),
      lease_nonce: "c".repeat(64),
      package_full_name: receipt().package.fullName,
    };
    expect(
      parseStoreAccountResult(
        "store_account_owner_bind",
        value,
        canonicalReceipt(),
      ).owner.pid,
    ).toBe(43);
    for (const change of [
      { owner: processIdentityToWire(identity(42)) },
      { gui: processIdentityToWire(identity(40)) },
      { bound: false },
      { package_full_name: "foreign" },
    ])
      expect(() =>
        parseStoreAccountResult(
          "store_account_owner_bind",
          { ...value, ...change },
          canonicalReceipt(),
        ),
      ).toThrow();
  });
});

async function storeServerFixture(options: {
  failure: "open" | "publish" | "accept" | "rotation";
  retirementFails?: boolean;
  removalFails?: boolean;
}) {
  const owner = await openStoreAccountNative(authority(42)),
    listener = await openStoreAccountNative(authority()),
    events: string[] = [];
  let openings = 0;
  fixture.request.mockImplementation((operation, args) => {
    events.push(operation);
    if (operation === "store_account_peer_verify")
      return {
        version: 1,
        verified: true,
        peer: args.peer,
        gui: processIdentityToWire(identity(41)),
        package_full_name: receipt().package.fullName,
      };
    if (operation === "store_account_ticket_publish") {
      if (options.failure === "publish")
        throw new Error("FIXTURE_PUBLISH_FAILED");
      return { version: 1, published: true, ticket: { ...ticket(), ...args } };
    }
    if (operation === "store_account_pipe_accept") {
      if (options.failure === "rotation")
        throw new ConsumerNativeError("TIMEOUT");
      throw new Error("FIXTURE_ACCEPT_FAILED");
    }
    if (operation === "store_account_ticket_remove") {
      if (options.removalFails) throw new Error("FIXTURE_REMOVE_DENIED");
      return { version: 1, removed: true };
    }
    throw new Error("FIXTURE_OP");
  });
  fixture.close.mockImplementation(async () => {
    events.push("listener-close");
    if (options.retirementFails)
      throw new Error("FIXTURE_JOB_ZERO_UNCONFIRMED");
  });
  return {
    owner,
    events,
    serve: () =>
      serveBrowserAccountAuthority(
        {
          kind: "store",
          native: owner,
          openNative: async () => {
            if (options.failure === "open" || openings++ > 0)
              throw new Error("FIXTURE_OPEN_FAILED");
            return listener;
          },
        },
        { instanceId: instance } as unknown as BrowserAccountAuthority,
        new AbortController().signal,
      ),
  };
}

describe("Store browser listener publication cleanup ownership", () => {
  it.each(["open", "publish"] as const)(
    "leaves an unowned existing ticket untouched when fresh listener %s fails",
    async (failure) => {
      const f = await storeServerFixture({ failure, removalFails: true });
      await expect(f.serve()).rejects.toThrow(
        failure === "open" ? "FIXTURE_OPEN_FAILED" : "FIXTURE_PUBLISH_FAILED",
      );
      expect(f.events).not.toContain("store_account_ticket_remove");
      expect(await f.owner.identity()).toEqual(identity(42));
      expect(fixture.close).toHaveBeenCalledTimes(failure === "open" ? 0 : 1);
    },
  );
  it("removes this instance's proved publication only after its failed listener retires", async () => {
    const f = await storeServerFixture({ failure: "accept" });
    await expect(f.serve()).rejects.toThrow("FIXTURE_ACCEPT_FAILED");
    expect(fixture.request).toHaveBeenLastCalledWith(
      "store_account_ticket_remove",
      { instance_id: instance },
    );
    expect(f.events.slice(-2)).toEqual([
      "listener-close",
      "store_account_ticket_remove",
    ]);
    expect(await f.owner.identity()).toEqual(identity(42));
  });
  it("retains publication ownership across an idle listener rotation and later open failure", async () => {
    const f = await storeServerFixture({ failure: "rotation" });
    await expect(f.serve()).rejects.toThrow("FIXTURE_OPEN_FAILED");
    expect(
      f.events.filter(
        (operation) => operation === "store_account_ticket_publish",
      ),
    ).toHaveLength(1);
    expect(fixture.request).toHaveBeenLastCalledWith(
      "store_account_ticket_remove",
      { instance_id: instance },
    );
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it("keeps the owned ticket and cleanup failure when listener retirement is unconfirmed", async () => {
    const f = await storeServerFixture({
      failure: "accept",
      retirementFails: true,
    });
    await expect(f.serve()).rejects.toBeInstanceOf(
      BrowserAccountCleanupUnconfirmed,
    );
    expect(f.events).toContain("store_account_ticket_publish");
    expect(f.events).not.toContain("store_account_ticket_remove");
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it("still propagates native removal denial for a publication this instance owns", async () => {
    const f = await storeServerFixture({
      failure: "accept",
      removalFails: true,
    });
    await expect(f.serve()).rejects.toThrow("FIXTURE_REMOVE_DENIED");
    expect(f.events.slice(-2)).toEqual([
      "listener-close",
      "store_account_ticket_remove",
    ]);
  });
});
describe("genuine Store account factory behavior (synthetic private-class fixture)", () => {
  it("rejects arbitrary adapters, receipts and constructor invocation", async () => {
    await expect(
      openStoreAccountNative({
        creatorProof: () => ({ helper: identity(43) }),
        accountOperation: () => ({ version: 1 }),
      } as unknown as StoreNativeAuthority),
    ).rejects.toThrow();
    await expect(
      Reflect.apply(openStoreAccountNative, undefined, [
        authority(),
        { allowUnsigned: true },
      ]),
    ).rejects.toThrow();
    expect(() =>
      Reflect.construct(StoreAccountNative, [Symbol("caller"), authority()]),
    ).toThrow("STORE_ACCOUNT_DENIED");
    expect(fixture.request).not.toHaveBeenCalled();
  });
  it("borrows real class methods instead of supplied overrides", async () => {
    const value = authority();
    Object.defineProperty(value, "accountOperation", {
      value: () => {
        throw new Error("OVERRIDE_CALLED");
      },
    });
    Object.defineProperty(value, "creatorProof", {
      value: () => {
        throw new Error("OVERRIDE_CALLED");
      },
    });
    fixture.request.mockReturnValue({ version: 1, ticket: null });
    const port = await openStoreAccountNative(value);
    expect(await port.readTicket()).toBe(null);
    expect(await port.identity()).toEqual(identity(43));
    expect(fixture.request).toHaveBeenCalledWith(
      "store_account_ticket_read",
      {},
    );
    await port.close();
    await port.close();
    expect(fixture.close).toHaveBeenCalledOnce();
    await expect(port.identity()).rejects.toThrow();
  });
  it("fences immediately and joins the same pending native retirement on every close", async () => {
    let release!: () => void;
    fixture.close.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const port = await openStoreAccountNative(authority()),
      first = port.close(),
      repeated = port.close();
    expect(repeated).toBe(first);
    let completed = false;
    void repeated.then(() => (completed = true));
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    await expect(port.readTicket()).rejects.toThrow("STORE_ACCOUNT_DENIED");
    expect(fixture.request).not.toHaveBeenCalled();
    release();
    await first;
    expect(completed).toBe(true);
    await port.close();
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it("keeps a failed native retirement observable to subsequent close callers", async () => {
    fixture.close.mockRejectedValue(new Error("FIXTURE_JOB_ZERO_UNCONFIRMED"));
    const port = await openStoreAccountNative(authority()),
      first = port.close();
    await expect(first).rejects.toThrow("FIXTURE_JOB_ZERO_UNCONFIRMED");
    expect(port.close()).toBe(first);
    await expect(port.close()).rejects.toThrow("FIXTURE_JOB_ZERO_UNCONFIRMED");
    expect(fixture.close).toHaveBeenCalledOnce();
    await expect(port.identity()).rejects.toThrow("STORE_ACCOUNT_DENIED");
  });
  it("publishes only with actual listener result and uses native generated expectations", async () => {
    fixture.request.mockImplementation((operation, args) => {
      if (operation !== "store_account_ticket_publish")
        throw new Error("FIXTURE_OP");
      return { version: 1, published: true, ticket: { ...ticket(), ...args } };
    });
    const port = await openStoreAccountNative(authority()),
      published = await port.publishTicket(identity(42), instance);
    expect(published.channel).toMatch(/^[a-f0-9]{64}$/u);
    expect(published.nonce).toMatch(/^[a-f0-9]{64}$/u);
    expect(published.nonce).not.toBe(published.channel);
    expect(published.server.pid).toBe(43);
    await expect(
      port.pipeAccept({
        channel: "x".repeat(64),
        nonce: published.nonce,
        peer: null,
      }),
    ).rejects.toThrow();
  });
  it("consumes native-owned connection exactly once before a reply attempt", async () => {
    let active = ticket();
    fixture.request.mockImplementation((operation, args) => {
      if (operation === "store_account_ticket_publish") {
        active = { ...ticket(), ...args };
        return { version: 1, published: true, ticket: active };
      }
      if (operation === "store_account_pipe_accept")
        return {
          version: 1,
          connection: {
            token: "d".repeat(64),
            nonce: active.nonce,
            peer: processIdentityToWire(identity(44)),
          },
          payload_base64: Buffer.from("مرحبا 🎵").toString("base64"),
        };
      if (operation === "store_account_pipe_reply")
        return { version: 1, replied: true };
      throw new Error("FIXTURE_OP");
    });
    const port = await openStoreAccountNative(authority()),
      published = await port.publishTicket(identity(42), instance),
      accepted = await port.pipeAccept({
        channel: published.channel,
        nonce: published.nonce,
        peer: null,
      });
    expect(accepted.payload.toString()).toBe("مرحبا 🎵");
    await expect(
      port.pipeReply(
        { ...accepted.connection, peer: identity(45) },
        Buffer.from("{}"),
      ),
    ).rejects.toThrow();
    await port.pipeReply(accepted.connection, Buffer.from("{}"));
    await expect(
      port.pipeReply(accepted.connection, Buffer.from("{}")),
    ).rejects.toThrow();
    expect(
      fixture.request.mock.calls.filter(
        ([operation]) => operation === "store_account_pipe_reply",
      ),
    ).toHaveLength(1);
  });
  it("never retries a connection after a missing/failed reply", async () => {
    fixture.request.mockRejectedValue(new Error("FIXTURE_REPLY_MISSING"));
    const port = await openStoreAccountNative(authority()),
      options = {
        channel: "a".repeat(64),
        nonce: "b".repeat(64),
        peer: identity(42),
        payload: Buffer.from("{}"),
      };
    await expect(port.pipeConnect(options)).rejects.toThrow(
      "FIXTURE_REPLY_MISSING",
    );
    await expect(port.pipeConnect(options)).rejects.toThrow(
      "STORE_ACCOUNT_DENIED",
    );
    expect(fixture.request).toHaveBeenCalledOnce();
  });
});
