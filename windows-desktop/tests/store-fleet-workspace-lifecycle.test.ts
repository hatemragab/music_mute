import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import { StoreFleetWorkspace } from "../src/main/fleet/store-workspace.js";
import { StoreNodeIssuer } from "../src/main/session/store-node-issuer.js";

const boundary = vi.hoisted(() => ({
  opens: vi.fn(),
  retire: vi.fn(),
  recoverRetire: vi.fn(),
  paths: vi.fn(),
  quiescent: true,
  failFirstOpen: false,
}));
// Synthetic private-class substitutes exercise only the adapter lifecycle.
// They grant no Store package, native directory, retained Job or GPU authority.
vi.mock("../src/main/session/store-node-issuer.js", () => {
  class Lease {
    #native: object;
    #paths: { root: string; input: string; output: string };
    #retirement: Promise<void> | undefined;
    #retired = false;
    constructor(native: object, root: string, extension: string) {
      this.#native = native;
      this.#paths = {
        root,
        input: win32.join(root, `input.${extension}`),
        output: win32.join(root, "output", "vocals.mp3"),
      };
    }
    assertHost(host: HostContext) {
      if (host.native !== this.#native) throw new Error("FOREIGN_HOST");
    }
    paths() {
      boundary.paths(this);
      if (this.#retired) throw new Error("RETIRED_LEASE");
      return this.#paths;
    }
    async inspect() {
      return { quiescent: boundary.quiescent, retired: this.#retired };
    }
    retire() {
      return (this.#retirement ??= this.#close());
    }
    async #close() {
      await boundary.retire(this);
      this.#retired = true;
    }
    async recoverRetire() {
      if (!this.#retirement) throw new Error("NO_ORIGINAL_RETIREMENT");
      boundary.recoverRetire(this);
      await this.#retirement.catch(() => {});
      this.#retirement = this.#close();
      await this.#retirement;
    }
    settleFailedOpen() {
      this.#retired = true;
    }
  }
  class Issuer {
    #native: object;
    #leases = new Map<string, Lease>();
    #failedOpens = new Set<string>();
    readonly inventorySha256 = "b".repeat(64);
    constructor(native: object) {
      this.#native = native;
    }
    get nodeRole() {
      return this.#native ? "fleet" : "personal";
    }
    assertNative(native: object) {
      if (native !== this.#native) throw new Error("FOREIGN_NATIVE");
      return native;
    }
    async codeView() {
      return {
        binding: {
          inventorySha256: this.inventorySha256,
          sid: "S-1-5-21-1-2-3-1001",
        },
      };
    }
    async openFleetAttempt(native: object, id: string, extension: string) {
      this.assertNative(native);
      let lease = this.#leases.get(id);
      if (!lease) {
        lease = new Lease(
          native,
          win32.join(
            "C:\\Users\\fixture\\AppData\\Local\\MusicMuteWorker\\work",
            id,
          ),
          extension,
        );
        this.#leases.set(id, lease);
      }
      boundary.opens(native, id, extension, lease);
      if ((await lease.inspect()).retired) throw new Error("RETIRED_LEASE");
      if (this.#failedOpens.has(id)) {
        lease.settleFailedOpen();
        return lease;
      }
      if (boundary.failFirstOpen) {
        boundary.failFirstOpen = false;
        this.#failedOpens.add(id);
        throw new Error("ORIGINAL_OPEN_PENDING");
      }
      return lease;
    }
  }
  return { StoreNodeIssuer: Issuer, StoreFleetAttemptLease: Lease };
});
beforeEach(() => {
  boundary.opens.mockReset();
  boundary.retire.mockReset().mockResolvedValue(undefined);
  boundary.recoverRetire.mockReset();
  boundary.paths.mockReset();
  boundary.quiescent = true;
  boundary.failFirstOpen = false;
});
async function fixture() {
  const identity = {
      sid: "S-1-5-21-1-2-3-1001",
      localAppData: "C:\\Users\\fixture\\AppData\\Local",
    },
    native = {
      identity: vi.fn(async () => identity),
      ensurePrivateDirectory: vi.fn(async () => {}),
    },
    host = {
      native,
      identity,
      personalRoot: win32.join(identity.localAppData, "MusicMuteLocal"),
    } as unknown as HostContext,
    issuer = Reflect.construct(StoreNodeIssuer, [native]) as StoreNodeIssuer,
    workspace = await StoreFleetWorkspace.open(host, issuer);
  return { native, host, issuer, workspace };
}
it("requires the actual private issuer/native association before opening or invoking caller getters", async () => {
  const getter = vi.fn(),
    host = {} as HostContext,
    issuer = Object.create(StoreNodeIssuer.prototype);
  Object.defineProperty(host, "native", { get: getter });
  Object.defineProperty(issuer, "nodeRole", { get: getter });
  await expect(StoreFleetWorkspace.open(host, issuer)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  const f = await fixture();
  await expect(
    StoreFleetWorkspace.open(
      { ...f.host, native: {} } as unknown as HostContext,
      f.issuer,
    ),
  ).rejects.toThrow();
  expect(() =>
    Reflect.construct(StoreFleetWorkspace, [
      Symbol("caller"),
      f.host,
      f.issuer,
      f.native,
      "C:\\foreign",
    ]),
  ).toThrow();
});
it("requires initialization and binds its work root to the current actual Native Known Folder", async () => {
  const f = await fixture();
  await expect(
    f.workspace.create(randomUUID(), "audio/mpeg"),
  ).rejects.toThrow();
  await f.workspace.initialize();
  expect(f.native.ensurePrivateDirectory).toHaveBeenCalledWith("fleet", "work");
  expect(boundary.opens).not.toHaveBeenCalled();
  await expect(
    StoreFleetWorkspace.open(
      { ...f.host, personalRoot: "C:\\foreign" } as HostContext,
      f.issuer,
    ),
  ).rejects.toThrow();
});
it("returns frozen original lease paths and requires the same returned object for cleanup", async () => {
  const f = await fixture(),
    id = randomUUID();
  await f.workspace.initialize();
  const paths = await f.workspace.create(id, "audio/mp4");
  expect(paths.input).toBe(
    win32.join(
      f.host.identity.localAppData,
      "MusicMuteWorker",
      "work",
      id,
      "input.m4a",
    ),
  );
  expect(Object.isFrozen(paths)).toBe(true);
  await expect(f.workspace.cleanup({ ...paths })).rejects.toThrow(
    "STORE_FLEET_WORKSPACE_DENIED",
  );
  expect(boundary.retire).not.toHaveBeenCalled();
  await f.workspace.cleanup(paths);
  expect(boundary.retire).toHaveBeenCalledWith(
    boundary.opens.mock.calls[0]![3],
  );
});
it("preserves a nonquiescent original attempt until the private native lease supplies actual cleanup evidence", async () => {
  const f = await fixture();
  await f.workspace.initialize();
  const paths = await f.workspace.create(randomUUID(), "audio/mpeg");
  boundary.quiescent = false;
  await expect(f.workspace.cleanup(paths)).rejects.toThrow(
    "STORE_FLEET_WORKSPACE_PENDING",
  );
  expect(boundary.retire).not.toHaveBeenCalled();
  boundary.quiescent = true;
  await f.workspace.cleanup(paths);
  expect(boundary.opens).toHaveBeenCalledOnce();
  expect(boundary.retire).toHaveBeenCalledOnce();
});
it("retains the original rejected creation and settles only that same failed lease without inventing paths", async () => {
  const f = await fixture(),
    id = randomUUID();
  await f.workspace.initialize();
  boundary.failFirstOpen = true;
  const failed = f.workspace.create(id, "audio/mpeg");
  await expect(failed).rejects.toThrow("ORIGINAL_OPEN_PENDING");
  const originalLease = boundary.opens.mock.calls[0]![3];
  await expect(f.workspace.create(id, "audio/mpeg")).rejects.toThrow(
    "STORE_FLEET_WORKSPACE_DENIED",
  );
  await expect(failed).rejects.toThrow("ORIGINAL_OPEN_PENDING");
  expect(boundary.opens.mock.calls[1]![3]).toBe(originalLease);
  expect(boundary.paths).not.toHaveBeenCalled();
  expect(boundary.retire).not.toHaveBeenCalled();
  await expect(f.workspace.create(id, "audio/mpeg")).rejects.toThrow(
    "RETIRED_LEASE",
  );
  expect(boundary.opens.mock.calls[2]![3]).toBe(originalLease);
});
it("retries an uncertain retirement only through the original private lease without another open", async () => {
  const f = await fixture();
  await f.workspace.initialize();
  const paths = await f.workspace.create(randomUUID(), "audio/mpeg"),
    originalLease = boundary.opens.mock.calls[0]![3];
  boundary.retire.mockRejectedValueOnce(
    new Error("ORIGINAL_HANDLE_CLOSE_PENDING"),
  );
  const failed = f.workspace.cleanup(paths);
  await expect(failed).rejects.toThrow("ORIGINAL_HANDLE_CLOSE_PENDING");
  await f.workspace.cleanup(paths);
  await expect(failed).rejects.toThrow("ORIGINAL_HANDLE_CLOSE_PENDING");
  expect(boundary.opens).toHaveBeenCalledOnce();
  expect(boundary.retire).toHaveBeenNthCalledWith(1, originalLease);
  expect(boundary.retire).toHaveBeenNthCalledWith(2, originalLease);
  expect(boundary.recoverRetire).toHaveBeenCalledOnce();
  expect(boundary.recoverRetire).toHaveBeenCalledWith(originalLease);
});
it("denies changed extension or a second live creation of the same original attempt", async () => {
  const f = await fixture(),
    id = randomUUID();
  await f.workspace.initialize();
  boundary.failFirstOpen = true;
  await expect(f.workspace.create(id, "audio/mpeg")).rejects.toThrow();
  await expect(f.workspace.create(id, "audio/wav")).rejects.toThrow();
  await expect(f.workspace.create(id, "audio/mpeg")).rejects.toThrow();
  const liveId = randomUUID(),
    paths = await f.workspace.create(liveId, "audio/mpeg");
  await expect(f.workspace.create(liveId, "audio/mpeg")).rejects.toThrow();
  await f.workspace.cleanup(paths);
});
it("joins concurrent retirement callers and never retries within the failed cleanup call", async () => {
  const f = await fixture();
  await f.workspace.initialize();
  const paths = await f.workspace.create(randomUUID(), "audio/mpeg");
  let reject!: (error: Error) => void;
  boundary.retire.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const first = f.workspace.cleanup(paths),
    second = f.workspace.cleanup(paths);
  await vi.waitFor(() => expect(boundary.retire).toHaveBeenCalledOnce());
  reject(new Error("ORIGINAL_HANDLE_CLOSE_PENDING"));
  await expect(first).rejects.toThrow("ORIGINAL_HANDLE_CLOSE_PENDING");
  await expect(second).rejects.toThrow("ORIGINAL_HANDLE_CLOSE_PENDING");
  expect(boundary.recoverRetire).not.toHaveBeenCalled();
  await f.workspace.cleanup(paths);
  expect(boundary.retire).toHaveBeenCalledTimes(2);
  expect(boundary.recoverRetire).toHaveBeenCalledOnce();
});
it("denies nonstring attempt IDs before invoking caller coercion or opening an attempt", async () => {
  const f = await fixture(),
    toString = vi.fn(() => randomUUID());
  await f.workspace.initialize();
  await expect(
    f.workspace.create({ toString } as unknown as string, "audio/mpeg"),
  ).rejects.toThrow("STORE_FLEET_WORKSPACE_DENIED");
  expect(toString).not.toHaveBeenCalled();
  expect(boundary.opens).not.toHaveBeenCalled();
});
