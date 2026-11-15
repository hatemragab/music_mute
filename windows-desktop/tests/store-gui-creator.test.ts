import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Server, Socket } from "node:net";
import type {
  StoreGuiCreatorProof,
  StoreNativeAuthority,
  StoreBootReceipt,
} from "../src/main/browser/store-native.js";
import type { StoreBrowserAttachment } from "../src/main/browser/store-registration.js";

// Portable protocol fixture only: genuine production private-brand boot and
// Windows kernel endpoint/code proof remain separate native acceptance gates.
const fixture = vi.hoisted(() => ({
  directory: "",
  routes: new Map<string, string>(),
  servers: [] as Server[],
  sockets: new Set<Socket>(),
  observeProof: vi.fn<(authority: unknown) => void>(),
}));
vi.mock("node:process", async (original) => ({
  ...(await original<typeof import("node:process")>()),
  platform: "win32",
  arch: "x64",
}));
vi.mock("node:net", async (original) => {
  const actual = await original<typeof import("node:net")>();
  return {
    ...actual,
    createServer: (
      options: import("node:net").ServerOpts,
      listener: (socket: Socket) => void,
    ) => {
      const server = actual.createServer(options, listener),
        listen = server.listen.bind(server);
      server.listen = ((path: string, callback: () => void) => {
        if (path !== `\\\\.\\pipe\\MusicMuteStoreGuiCreator-${process.pid}`)
          throw new Error("FIXTURE_FIXED_PIPE_REQUIRED");
        const route = join(fixture.directory, `p-${fixture.routes.size}.sock`);
        fixture.routes.set(path, route);
        return listen(route, callback);
      }) as typeof server.listen;
      fixture.servers.push(server);
      return server;
    },
  };
});
vi.mock("../src/main/browser/store-native.js", () => ({
  StoreNativeAuthority: class {
    readonly receipt: StoreBootReceipt;
    #proof: StoreGuiCreatorProof;
    #closed = false;
    #attachment: StoreBrowserAttachment | undefined;
    constructor(proof: StoreGuiCreatorProof) {
      this.#proof = proof;
      this.receipt = creatorReceipt(proof);
    }
    creatorProof() {
      fixture.observeProof(this);
      if (this.#closed) throw new Error("FIXTURE_CLOSED_BRAND");
      return this.#proof;
    }
    close() {
      this.#closed = true;
    }
    browserCreatorProof() {
      if (this.#closed || !this.#attachment)
        throw new Error("FIXTURE_BROWSER_UNBOUND");
      return this.#attachment;
    }
    attachFixture(attachment: StoreBrowserAttachment) {
      this.#attachment = attachment;
    }
  },
}));
import { createConnection } from "node:net";
import { StoreNativeAuthority as NativeFixture } from "../src/main/browser/store-native.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { STORE_BROWSER_ORIGIN } from "../src/main/browser/store-registration.js";
import {
  parseStoreGuiCreatorQuery,
  registerStoreGuiCreator,
  STORE_GUI_CREATOR_MAX_FRAME,
  STORE_GUI_CREATOR_TIMEOUT_MS,
  type StoreGuiCreatorLease,
} from "../src/main/browser/store-gui-creator.js";

const birth = "1337133713371337",
  childPid = process.pid + 1;
const leases: StoreGuiCreatorLease[] = [];
function creatorReceipt(proof: StoreGuiCreatorProof): StoreBootReceipt {
  const product = STORE_PRODUCTS.gui;
  return {
    version: 1,
    package: {
      identityName: product.identityName,
      publisher: product.publisher,
      publisherId: product.publisherId,
      familyName: product.familyName,
      fullName: proof.packageFullName,
      packageVersion: "0.1.0.2",
      architecture: "x64",
      signatureKind: 3,
      healthy: true,
      current: true,
      installedLocation: `C:\\Program Files\\WindowsApps\\${proof.packageFullName}`,
    },
    helper: proof.helper,
    parent: proof.gui,
    logonSid: "S-1-5-5-1-42",
  };
}
function attachFixture(value: StoreNativeAuthority) {
  const own = proof();
  const attachment: StoreBrowserAttachment = {
    version: 1,
    accepted: true,
    host: { ...own.gui, pid: process.pid + 20 },
    gui: own.gui,
    chrome: { ...own.gui, pid: process.pid + 21 },
    origin: STORE_BROWSER_ORIGIN,
    packageFullName: own.packageFullName,
  };
  Reflect.apply(
    Reflect.get(Object.getPrototypeOf(value), "attachFixture"),
    value,
    [attachment],
  );
  return attachment;
}
function proof(pid = childPid): StoreGuiCreatorProof {
  const identity = { sid: "S-1-5-21-1-2-3-1001", sessionId: 1 };
  return {
    version: 1,
    gui: { ...identity, pid: process.pid, creationTime: "1337133713371000" },
    helper: { ...identity, pid, creationTime: birth },
    packageFullName: `${STORE_PRODUCTS.gui.identityName}_0.1.0.2_x64__${STORE_PRODUCTS.gui.publisherId}`,
  };
}
function authority(value = proof()) {
  return Reflect.construct(NativeFixture, [value]) as StoreNativeAuthority;
}
function frame(
  challenge = "a".repeat(64),
  extra: Record<string, unknown> = {},
) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      challenge,
      helper_pid: childPid,
      helper_creation_time: birth,
      ...extra,
    }) + "\n",
  );
}
async function register(value = authority()) {
  const lease = await registerStoreGuiCreator(value);
  leases.push(lease);
  const route = fixture.routes.get(
    `\\\\.\\pipe\\MusicMuteStoreGuiCreator-${process.pid}`,
  );
  if (!route) throw new Error("FIXTURE_ROUTE_MISSING");
  return { lease, route, value };
}
async function connect(route: string) {
  const socket = createConnection(route);
  fixture.sockets.add(socket);
  socket.on("error", () => undefined);
  socket.once("close", () => fixture.sockets.delete(socket));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}
async function response(
  route: string,
  bytes = frame(),
  split = false,
): Promise<Buffer> {
  const socket = await connect(route);
  const result = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => {
      socket.end();
      resolve(Buffer.concat(chunks));
    });
    socket.once("close", (hadError) => {
      if (hadError) reject(new Error("FIXTURE_CLOSED"));
      else resolve(Buffer.concat(chunks));
    });
  });
  if (split) {
    socket.write(bytes.subarray(0, 19));
    socket.write(bytes.subarray(19));
  } else socket.write(bytes);
  return result;
}
beforeEach(async () => {
  fixture.observeProof.mockReset();
  fixture.directory = await mkdtemp("/tmp/mm-gui-creator-");
  fixture.routes.clear();
  fixture.servers.length = 0;
});
afterEach(async () => {
  vi.useRealTimers();
  for (const socket of fixture.sockets) socket.destroy();
  await Promise.all(leases.splice(0).map((lease) => lease.close()));
  expect(fixture.servers.every((server) => !server.listening)).toBe(true);
  await rm(fixture.directory, { recursive: true });
});
describe("Store creator receiving grammar (no authority from queries)", () => {
  it("parses one exact bounded UTF8 line", () => {
    const parsed = parseStoreGuiCreatorQuery(frame());
    expect(parsed.helper_pid).toBe(childPid);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed).not.toHaveProperty("creatorProof");
  });
  it.each([
    { version: 2 },
    { challenge: "A".repeat(64) },
    { helper_pid: 0 },
    { helper_pid: "123" },
    { helper_creation_time: "001" },
    { helper_creation_time: "18446744073709551616" },
    { package_full_name: proof().packageFullName },
  ])("rejects invalid or caller-authorizing fields %j", (change) => {
    expect(() => parseStoreGuiCreatorQuery(frame(undefined, change))).toThrow(
      "STORE_GUI_CREATOR_DENIED",
    );
  });
  it.each([
    Buffer.concat([frame(), frame()]),
    frame().subarray(0, -1),
    Buffer.from([255, 10]),
    Buffer.concat([Buffer.from([239, 187, 191]), frame()]),
    Buffer.from(frame().toString().replace("\n", "\r\n")),
    Buffer.alloc(STORE_GUI_CREATOR_MAX_FRAME + 1, 32),
    Buffer.from(
      `{"version":1,"challenge":"${"a".repeat(64)}","helper_pid":${childPid},"helper_pid":${childPid},"helper_creation_time":"${birth}"}\n`,
    ),
  ])("rejects multiple, duplicate, unframed and non-UTF8 input", (bytes) => {
    expect(() => parseStoreGuiCreatorQuery(bytes)).toThrow(
      "STORE_GUI_CREATOR_DENIED",
    );
  });
});
describe("portable real-socket creator table (not Windows Store/peer proof)", () => {
  it("rejects supplied receipt/verifier adapters before creating an endpoint", async () => {
    await expect(
      registerStoreGuiCreator({
        creatorProof: () => proof(),
      } as unknown as StoreNativeAuthority),
    ).rejects.toThrow();
    await expect(
      Reflect.apply(registerStoreGuiCreator, undefined, [
        authority(),
        { accepted: true, path: "caller" },
      ]),
    ).rejects.toThrow("STORE_GUI_CREATOR_DENIED");
    expect(fixture.servers).toHaveLength(0);
  });
  it("borrows the class private method and ignores an overridden instance method", async () => {
    const value = authority();
    Object.defineProperty(value, "creatorProof", {
      value: () => {
        throw new Error("UNTRUSTED_OVERRIDE_CALLED");
      },
    });
    const { route } = await register(value);
    expect(
      JSON.parse((await response(route, frame(), true)).toString()),
    ).toEqual({
      version: 1,
      confirmed: true,
      challenge: "a".repeat(64),
      helper_pid: childPid,
      helper_creation_time: birth,
      package_full_name: proof().packageFullName,
      browser_attachment: null,
      source_helper: null,
    });
  });
  it("rejects the same live helper duplicate and serves distinct genuine helpers on one endpoint", async () => {
    const first = await register();
    await expect(registerStoreGuiCreator(authority())).rejects.toThrow(
      "STORE_GUI_CREATOR_DENIED",
    );
    const second = await register(authority(proof(childPid + 1)));
    expect(second.route).toBe(first.route);
    expect(fixture.servers).toHaveLength(1);
    expect(
      JSON.parse(
        (
          await response(
            first.route,
            frame("b".repeat(64), { helper_pid: childPid + 1 }),
          )
        ).toString(),
      ).confirmed,
    ).toBe(true);
    await first.lease.close();
    expect(
      JSON.parse(
        (await response(second.route, frame("c".repeat(64)))).toString(),
      ).confirmed,
    ).toBe(false);
    await second.lease.close();
    await second.lease.close();
    await expect(connect(second.route)).rejects.toThrow();
  });
  it("rechecks the private live state for every query and refuses closed authority", async () => {
    const { value, route } = await register();
    expect(JSON.parse((await response(route)).toString()).confirmed).toBe(true);
    await value.close();
    expect(
      JSON.parse((await response(route, frame("b".repeat(64)))).toString()),
    ).toMatchObject({ confirmed: false, package_full_name: "" });
  });
  it("does not disclose a package or confirm mismatched PID/birth", async () => {
    const { route } = await register();
    expect(
      JSON.parse(
        (
          await response(
            route,
            frame(undefined, { helper_creation_time: "1337133713371338" }),
          )
        ).toString(),
      ),
    ).toMatchObject({ confirmed: false, package_full_name: "" });
  });
  it("does not replay a challenge or accept a second frame", async () => {
    const { route } = await register();
    expect((await response(route)).length).toBeGreaterThan(0);
    expect((await response(route)).length).toBe(0);
    expect(
      (
        await response(
          route,
          Buffer.concat([frame("b".repeat(64)), frame("c".repeat(64))]),
        )
      ).length,
    ).toBe(0);
  });
  it("bounds incomplete or oversized connections without changing listener lifetime", async () => {
    const { route } = await register();
    expect(
      (await response(route, Buffer.alloc(STORE_GUI_CREATOR_MAX_FRAME + 1, 32)))
        .length,
    ).toBe(0);
    const socket = await connect(route);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Accept is scheduled by the real server before its fixed timer is created.
    const accepted = await connect(route);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closed = new Promise<void>((resolve) =>
      accepted.once("close", () => resolve()),
    );
    await vi.advanceTimersByTimeAsync(STORE_GUI_CREATOR_TIMEOUT_MS);
    await closed;
    socket.destroy();
    vi.useRealTimers();
    expect(
      JSON.parse((await response(route, frame("d".repeat(64)))).toString())
        .confirmed,
    ).toBe(true);
  });
  it("requires genuine private attachment state and its own lease before browser scope", async () => {
    const first = await register();
    await expect(
      first.lease.bindBrowserAttachment(first.value),
    ).rejects.toThrow("FIXTURE_BROWSER_UNBOUND");
    await expect(
      first.lease.bindBrowserAttachment(authority()),
    ).rejects.toThrow("STORE_GUI_CREATOR_DENIED");
    const attachment = attachFixture(first.value);
    Object.defineProperty(first.value, "browserCreatorProof", {
      value: () => {
        throw new Error("OVERRIDE_CALLED");
      },
    });
    await first.lease.bindBrowserAttachment(first.value);
    await expect(
      first.lease.bindBrowserAttachment(first.value),
    ).rejects.toThrow("STORE_GUI_CREATOR_DENIED");
    const result = JSON.parse((await response(first.route)).toString());
    expect(result.browser_attachment).toMatchObject({
      accepted: true,
      host: { pid: attachment.host.pid },
      chrome: { pid: attachment.chrome.pid },
      origin: STORE_BROWSER_ORIGIN,
    });
  });
  it("only privately derived helpers borrow the exact attached source and lose it on source close", async () => {
    const first = await register(),
      second = await register(authority(proof(childPid + 1)));
    attachFixture(first.value);
    await first.lease.bindBrowserAttachment(first.value);
    const ordinary = JSON.parse(
      (
        await response(
          second.route,
          frame("e".repeat(64), { helper_pid: childPid + 1 }),
        )
      ).toString(),
    );
    expect(ordinary.browser_attachment).toBeNull();
    expect(ordinary.source_helper).toBeNull();
    await second.lease.deriveBrowserSource(first.value);
    expect(
      JSON.parse(
        (
          await response(
            second.route,
            frame(undefined, { helper_pid: childPid + 1 }),
          )
        ).toString(),
      ).browser_attachment,
    ).not.toBeNull();
    await first.value.close();
    const result = JSON.parse(
      (
        await response(
          second.route,
          frame("b".repeat(64), { helper_pid: childPid + 1 }),
        )
      ).toString(),
    );
    expect(result.confirmed).toBe(true);
    expect(result.browser_attachment).toBeNull();
    expect(result.source_helper).toBeNull();
    await first.lease.close();
    await expect(
      first.lease.bindBrowserAttachment(first.value),
    ).rejects.toThrow("STORE_GUI_CREATOR_DENIED");
  });
  it("drops a source closed during the last target-proof await before replying", async () => {
    const first = await register(),
      second = await register(authority(proof(childPid + 1)));
    attachFixture(first.value);
    await first.lease.bindBrowserAttachment(first.value);
    await second.lease.deriveBrowserSource(first.value);
    let targetReads = 0;
    fixture.observeProof.mockImplementation((value) => {
      if (value === second.value && ++targetReads === 2)
        void first.value.close();
    });
    const result = JSON.parse(
      (
        await response(
          second.route,
          frame(undefined, { helper_pid: childPid + 1 }),
        )
      ).toString(),
    );
    expect(targetReads).toBeGreaterThanOrEqual(2);
    expect(result.confirmed).toBe(true);
    expect(result.browser_attachment).toBeNull();
    expect(result.source_helper).toBeNull();
  });
  it("rejects unbound, foreign, repeated and chained source relationships", async () => {
    const first = await register(),
      second = await register(authority(proof(childPid + 1))),
      third = await register(authority(proof(childPid + 2)));
    await expect(second.lease.deriveBrowserSource(first.value)).rejects.toThrow(
      "STORE_GUI_CREATOR_DENIED",
    );
    attachFixture(first.value);
    await first.lease.bindBrowserAttachment(first.value);
    await expect(second.lease.deriveBrowserSource(authority())).rejects.toThrow(
      "STORE_GUI_CREATOR_DENIED",
    );
    await second.lease.deriveBrowserSource(first.value);
    await expect(second.lease.deriveBrowserSource(first.value)).rejects.toThrow(
      "STORE_GUI_CREATOR_DENIED",
    );
    await expect(third.lease.deriveBrowserSource(second.value)).rejects.toThrow(
      "STORE_GUI_CREATOR_DENIED",
    );
    const result = JSON.parse(
      (
        await response(
          second.route,
          frame("f".repeat(64), { helper_pid: childPid + 1 }),
        )
      ).toString(),
    );
    expect(result.source_helper).toEqual({
      pid: childPid,
      creation_time: birth,
    });
  });
});
