import { createHash } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { REQUIRED_STORE_GUI_RESOURCES } from "../src/main/browser/store-resource-index.js";
import { STORE_BROWSER_ORIGIN } from "../src/main/browser/store-registration.js";

// Real Authority private fields/factory exercised across synthetic native,
// sealed-resource and issuer boundaries. No Windows/Store/Chrome proof.
const fixture = vi.hoisted(() => ({
  seal: Buffer.alloc(0),
  root: "",
  counter: 0,
  foreignNext: false,
  failClosePid: 0,
  deriveGate: undefined as Promise<void> | undefined,
  transports: [] as Array<{ pid: number; close: ReturnType<typeof vi.fn> }>,
  derive: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getAppPath: () => `${fixture.root}\\app\\resources\\app.asar`,
  },
}));
vi.mock("node:fs/promises", () => ({
  lstat: async (path: string) => ({
    isFile: () => true,
    isSymbolicLink: () => false,
    nlink: 1,
    size: path.endsWith("packaged-resources.json") ? fixture.seal.length : 1,
  }),
  readFile: async (path: string) =>
    path.endsWith("packaged-resources.json") ? fixture.seal : Buffer.from([1]),
}));
vi.mock("../src/main/browser/store-gui-issuer.js", () => ({
  StoreGuiBootstrapIssuer: {
    open: async () => ({
      bindSpawnedProcess: () => "a".repeat(64),
      confirmBootHelper: async () => {},
      close: async () => {},
    }),
  },
}));
vi.mock("../src/main/browser/store-gui-creator.js", () => ({
  registerStoreGuiCreator: async () => ({
    bindBrowserAttachment: async () => {},
    deriveBrowserSource: async (source: unknown) => {
      fixture.derive(source);
      await fixture.deriveGate;
    },
    close: async () => {},
  }),
}));
vi.mock(
  "../../worker/src/platform/windows/consumer-native.js",
  async (original) => ({
    ...(await original<
      typeof import("../../worker/src/platform/windows/consumer-native.js")
    >()),
    WindowsConsumerNative: class {
      constructor(
        private transport: {
          request(operation: string, args: unknown): Promise<unknown>;
        },
      ) {}
      identity() {
        return this.transport.request("identity", {});
      }
    },
  }),
);
vi.mock(
  "../../worker/src/platform/windows/consumer-native-transport.js",
  () => ({
    createStoreConsumerNativeTransport: async () => {
      const pid = process.pid + 100 + ++fixture.counter;
      const version = fixture.foreignNext ? "0.1.0.3" : "0.1.0.2";
      fixture.foreignNext = false;
      const product = STORE_PRODUCTS.gui;
      const fullName = `${product.identityName}_${version}_x64__${product.publisherId}`;
      const own = {
        sid: "S-1-5-21-1-2-3-1001",
        session_id: 1,
        pid,
        creation_time: String(200 + fixture.counter),
      };
      const parent = { ...own, pid: process.pid, creation_time: "100" };
      const close = vi.fn(async () => {
        if (fixture.failClosePid === pid)
          throw Error("EXACT_HELPER_CLOSE_FAILED");
      });
      fixture.transports.push({ pid, close });
      return {
        spawnedProcessId: pid,
        close,
        onClosed() {},
        request: async (operation: string, args: Record<string, unknown>) => {
          if (operation === "store_boot")
            return {
              version: 1,
              package: {
                identityName: product.identityName,
                publisher: product.publisher,
                publisherId: product.publisherId,
                familyName: product.familyName,
                fullName,
                packageVersion: version,
                architecture: "x64",
                signatureKind: 3,
                healthy: true,
                current: true,
                installedLocation: fixture.root,
              },
              helper: own,
              parent,
              logon_sid: "S-1-5-5-1-42",
            };
          if (operation === "store_package_lock")
            return {
              token: "b".repeat(64),
              path: `${fixture.root}\\${String(args.path).replaceAll("/", "\\")}`,
              full_name: fullName,
              sha256: args.sha256,
              bytes: args.bytes,
            };
          if (operation === "store_package_release") return { released: true };
          if (operation === "store_private_boot")
            return { authorized: true, namespace: "unvirtualized-v1" };
          if (operation === "identity")
            return {
              sid: own.sid,
              sessionId: 1,
              pid,
              creationTime: own.creation_time,
              logonSid: "S-1-5-5-1-42",
            };
          if (operation === "store_browser_attach")
            return {
              version: 1,
              accepted: true,
              gui: parent,
              host: { ...own, pid: args.host_pid },
              chrome: { ...own, pid: process.pid + 60 },
              origin: STORE_BROWSER_ORIGIN,
              package_full_name: fullName,
            };
          throw Error(`UNEXPECTED_FIXTURE_OPERATION:${operation}`);
        },
      };
    },
  }),
);
import { StoreNativeAuthority } from "../src/main/browser/store-native.js";
import { StoreShareNative } from "../src/main/share/store-share-native.js";
import type { HostContext } from "../src/main/host-context.js";

beforeEach(() => {
  const product = STORE_PRODUCTS.gui;
  fixture.root = `C:\\Program Files\\WindowsApps\\${product.identityName}_0.1.0.2_x64__${product.publisherId}`;
  const bytes = Buffer.from([1]),
    digest = createHash("sha256").update(bytes).digest("hex");
  fixture.seal = Buffer.from(
    JSON.stringify({
      version: 2,
      authority: {
        kind: "microsoft-store",
        role: "gui",
        identity: { ...product },
        packageVersion: "0.1.0.0",
        protocolAbi: 1,
      },
      appVersion: "0.1.0",
      buildNumber: 1,
      entries: REQUIRED_STORE_GUI_RESOURCES.map((name) => {
        const [placement, path] = name.split(":");
        return { placement, path, bytes: 1, sha256: digest };
      }),
    }),
  );
  // Product contract contains fields outside the exact identity wire shape.
  const seal = JSON.parse(fixture.seal.toString());
  seal.authority.identity = {
    identityName: product.identityName,
    publisher: product.publisher,
    publisherId: product.publisherId,
    familyName: product.familyName,
    storeId: product.storeId,
  };
  fixture.seal = Buffer.from(JSON.stringify(seal));
  fixture.counter = 0;
  fixture.foreignNext = false;
  fixture.failClosePid = 0;
  fixture.deriveGate = undefined;
  fixture.transports = [];
  fixture.derive.mockReset();
  vi.stubGlobal("process", {
    ...process,
    platform: "win32",
    arch: "x64",
    execPath: `${fixture.root}\\app\\MusicMute Local.exe`,
    resourcesPath: `${fixture.root}\\app\\resources`,
    windowsStore: true,
    versions: { ...process.versions, electron: "40.0.0" },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
async function source() {
  const value = await StoreNativeAuthority.open();
  await value.openGuiDataNative();
  await value.browserAttach({
    hostPid: process.pid + 50,
    nonce: "c".repeat(64),
    origin: STORE_BROWSER_ORIGIN,
  });
  return value;
}
it("derives only from the original real private source and retains its stable helper", async () => {
  const original = await source(),
    peer = await StoreNativeAuthority.openBrowserWaitingPeer(original);
  expect(peer.browserSourceCreatorProof()).toEqual(original.creatorProof());
  expect(peer.creatorProof().helper.pid).not.toBe(
    original.creatorProof().helper.pid,
  );
  expect(fixture.derive).toHaveBeenCalledWith(original);
  await expect(
    StoreNativeAuthority.openBrowserWaitingPeer(peer),
  ).rejects.toThrow("STORE_AUTHORITY_DENIED");
  await original.close();
  expect(
    fixture.transports.every((row) => row.close.mock.calls.length === 1),
  ).toBe(true);
  expect(() => peer.browserCreatorProof()).toThrow();
});
it("rejects forged brands and an unbound real source before creating another helper", async () => {
  const fake = Object.assign(Object.create(StoreNativeAuthority.prototype), {
    browserSourceCreatorProof: vi.fn(() => ({})),
    creatorProof: vi.fn(() => ({})),
  });
  await expect(
    StoreNativeAuthority.openBrowserWaitingPeer(fake),
  ).rejects.toThrow();
  const actual = await StoreNativeAuthority.open();
  await actual.openGuiDataNative();
  await expect(
    StoreNativeAuthority.openBrowserWaitingPeer(actual),
  ).rejects.toThrow("STORE_AUTHORITY_DENIED");
  expect(fixture.transports).toHaveLength(1);
  await actual.close();
});
it("keeps a source close pending until its exact in-construction helper retires", async () => {
  const original = await source();
  let release!: () => void;
  fixture.deriveGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const opening = StoreNativeAuthority.openBrowserWaitingPeer(original);
  await vi.waitFor(() => expect(fixture.derive).toHaveBeenCalledOnce());
  let closed = false;
  const closing = original.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await expect(opening).rejects.toThrow("STORE_AUTHORITY_DENIED");
  await closing;
  expect(
    fixture.transports.every((row) => row.close.mock.calls.length === 1),
  ).toBe(true);
});
it("does not claim original source cleanup when its derived helper teardown fails", async () => {
  const original = await source(),
    peer = await StoreNativeAuthority.openBrowserWaitingPeer(original);
  fixture.failClosePid = peer.creatorProof().helper.pid;
  await expect(original.close()).rejects.toThrow("CLEANUP_UNCONFIRMED");
  expect(() => original.creatorProof()).toThrow();
  expect(() => peer.creatorProof()).toThrow();
});
it("owns a Share helper from actual GUI data without giving it Chrome scope", async () => {
  const original = await StoreNativeAuthority.open();
  await original.openGuiDataNative();
  const peer = await StoreNativeAuthority.openSharePeer(original);
  expect(peer.borrowDataNative()).toBeDefined();
  expect(() => peer.browserCreatorProof()).toThrow("STORE_AUTHORITY_DENIED");
  expect(fixture.derive).not.toHaveBeenCalled();
  await original.close();
  expect(
    fixture.transports.every((row) => row.close.mock.calls.length === 1),
  ).toBe(true);
});
it("keeps Share class retirement separate from its original private GUI source", async () => {
  const original = await StoreNativeAuthority.open();
  const native = await original.openGuiDataNative();
  const sharing = await StoreShareNative.open({
    storeAuthority: original,
    native,
  } as unknown as HostContext);
  expect(await sharing.identity()).toMatchObject({
    pid: fixture.transports[1]!.pid,
  });
  expect(fixture.derive).not.toHaveBeenCalled();
  await sharing.close();
  expect(fixture.transports[1]!.close).toHaveBeenCalledOnce();
  expect(fixture.transports[0]!.close).not.toHaveBeenCalled();
  expect(original.creatorProof()).toBeDefined();
  await expect(sharing.identity()).rejects.toThrow("STORE_SHARE_DENIED");
  await original.close();
  expect(fixture.transports[1]!.close).toHaveBeenCalledOnce();
});
it("retains the exact failed Share helper close instead of claiming GUI source cleanup", async () => {
  const original = await StoreNativeAuthority.open();
  const native = await original.openGuiDataNative();
  const sharing = await StoreShareNative.open({
    storeAuthority: original,
    native,
  } as unknown as HostContext);
  fixture.failClosePid = (await sharing.identity()).pid;
  const closing = sharing.close();
  expect(sharing.close()).toBe(closing);
  await expect(closing).rejects.toThrow("EXACT_HELPER_CLOSE_FAILED");
  expect(original.creatorProof()).toBeDefined();
  await expect(original.close()).rejects.toThrow("CLEANUP_UNCONFIRMED");
  expect(fixture.transports[1]!.close).toHaveBeenCalledOnce();
});
it("refuses the pure Node factory before importing Electron or spawning a helper", async () => {
  vi.stubGlobal("process", {
    ...process,
    versions: { ...process.versions, electron: undefined },
  });
  await expect(StoreNativeAuthority.open()).rejects.toThrow(
    "STORE_AUTHORITY_DENIED",
  );
  expect(fixture.transports).toHaveLength(0);
});
