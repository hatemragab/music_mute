import { expect, it, vi } from "vitest";
import { HostContext, type HostNativePort } from "../src/main/host-context.js";
function fixture() {
  const secrets = new Map<string, Buffer>();
  const native: HostNativePort = {
    openPrivateFile: vi.fn(async () => {
      throw new Error("fixture-unused");
    }),
    removeRuntimeRepairBackup: vi.fn(async () => {
      throw new Error("fixture-unused");
    }),
    beginCacheDeletion: vi.fn(async () => {
      throw new Error("fixture-unused");
    }),
    commitCacheDeletion: vi.fn(async () => {
      throw new Error("fixture-unused");
    }),
    releaseCacheDeletion: vi.fn(async () => {
      throw new Error("fixture-unused");
    }),
    recoverCacheDeletions: vi.fn(async () => {
      throw new Error("fixture-unused");
    }),
    bootIdentity: async () => "e".repeat(64),
    identity: async () => ({
      sid: "S-1-5-21-1-2-3-1001",
      logonSid: "S-1-5-5-1-2",
      sessionId: 1,
      pid: 123,
      creationTime: "133000000000000000",
      nativeArch: "x64",
      processArch: "x64",
      osMajor: 10,
      osBuild: 19045,
      localAppData: "C:\\Users\\Fixture\\AppData\\Local",
    }),
    ensurePrivateDirectory: async () =>
      "C:\\Users\\Fixture\\AppData\\Local\\MusicMuteLocal",
    validatePath: async () => {},
    vaultRead: async (namespace, key) => {
      expect(namespace).toBe("account");
      return secrets.get(key) ?? null;
    },
    vaultWrite: async (namespace, key, bytes) => {
      expect(namespace).toBe("account");
      secrets.set(key, Buffer.from(bytes));
    },
    vaultDelete: async (namespace, key) => {
      expect(namespace).toBe("account");
      secrets.delete(key);
    },
    acquireMutex: async (scope) => ({
      scope,
      nonce: "a".repeat(64),
      identity: await native.identity(),
      abandoned: false,
    }),
    releaseMutex: vi.fn(async () => {}),
    enumerateGpus: async () => [],
    close: vi.fn(async () => {}),
  };
  return { native, secrets };
}
it("persists stable installation identity and signed-out tombstone solely through the account vault", async () => {
  const { native, secrets } = fixture();
  const host = await HostContext.initialize(native, "0.1.0", 1);
  expect(host.storeAuthority).toBeUndefined();
  await host.accountState.writeSignedOut(true);
  expect(await host.accountState.readSignedOut()).toBe(true);
  await host.accountState.saveMetadataRevision!(2);
  const restored = await HostContext.initialize(native, "0.2.0", 2);
  expect(restored.report.installationId).toBe(host.report.installationId);
  expect(restored.report.metadataRevision).toBe(2);
  secrets.set("signout_state", Buffer.from("not-json"));
  await expect(restored.accountState.readSignedOut()).rejects.toThrow(
    "VAULT_CORRUPT",
  );
});
it("rejects redirected native roots and corrupt installation state rather than silently replacing identity", async () => {
  const { native, secrets } = fixture();
  native.ensurePrivateDirectory = async () => "C:\\Public";
  await expect(HostContext.initialize(native, "0.1.0", 1)).rejects.toThrow(
    "PATH_UNSAFE",
  );
  native.ensurePrivateDirectory = async () =>
    "C:\\Users\\Fixture\\AppData\\Local\\MusicMuteLocal";
  secrets.set(
    "installation",
    Buffer.from(
      '{"version":1,"installationId":"invalid","metadataRevision":1}',
    ),
  );
  await expect(HostContext.initialize(native, "0.1.0", 1)).rejects.toThrow(
    "VAULT_CORRUPT",
  );
});
it("publishes scope invalidation before a failing listener and never exposes credential material through scope", async () => {
  const { native } = fixture();
  const host = await HostContext.initialize(native, "0.1.0", 1);
  const scopes: unknown[] = [];
  host.onAccountScope(async (scope) => {
    scopes.push(scope);
  });
  await host.accountState.publishScope({
    firebaseUid: "fixture-uid",
    generation: "epoch-1",
  });
  host.onAccountScope(async () => {
    throw new Error("transport unavailable");
  });
  await expect(host.accountState.publishScope(null)).rejects.toThrow();
  expect(host.accountScope()).toBe(null);
  expect(scopes).toEqual([
    { firebaseUid: "fixture-uid", generation: "epoch-1" },
    null,
  ]);
});
it("a synchronous consumer failure cannot skip later immediate fences or finish retirement before their actual cleanup", async () => {
  const { native } = fixture(),
    host = await HostContext.initialize(native, "0.1.0", 1),
    events: string[] = [];
  await host.accountState.publishScope({
    firebaseUid: "owner-a",
    generation: "epoch-a",
  });
  let finish!: () => void,
    settled = false;
  host.onAccountScope(() => {
    events.push("throwing");
    throw new Error("Bearer secret /private/grant");
  });
  host.onAccountScope((scope) => {
    expect(scope).toBeNull();
    events.push("slow fence");
    return new Promise<void>((done) => {
      finish = done;
    });
  });
  host.onAccountScope(async (scope) => {
    expect(scope).toBeNull();
    events.push("last fence");
  });
  const retiring = host.accountState.publishScope(null).then(
    () => {
      settled = true;
      return "success";
    },
    (error: Error) => {
      settled = true;
      return error.message;
    },
  );
  expect(host.accountScope()).toBeNull();
  expect(events).toEqual(["throwing", "slow fence", "last fence"]);
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  expect(await retiring).toBe("ACCOUNT_SCOPE_TRANSITION_FAILED");
});
it("late rejected A cleanup cannot publish another null event or retire accepted B", async () => {
  const { native } = fixture(),
    host = await HostContext.initialize(native, "0.1.0", 1),
    observed: unknown[] = [];
  let rejectOld!: (error: Error) => void;
  host.onAccountScope((scope) =>
    scope === null
      ? new Promise<void>((_done, fail) => {
          rejectOld = fail;
        })
      : Promise.resolve(),
  );
  host.onAccountScope(async (scope) => {
    observed.push(scope);
  });
  await host.accountState.publishScope({
    firebaseUid: "owner-a",
    generation: "epoch-a",
  });
  const retired = host.accountState
    .publishScope(null)
    .catch((error: Error) => error.message);
  await host.accountState.publishScope({
    firebaseUid: "owner-b",
    generation: "epoch-b",
  });
  rejectOld(new Error("old private cleanup"));
  expect(await retired).toBe("ACCOUNT_SCOPE_TRANSITION_FAILED");
  expect(host.accountScope()).toEqual({
    firebaseUid: "owner-b",
    generation: "epoch-b",
  });
  expect(observed).toEqual([
    { firebaseUid: "owner-a", generation: "epoch-a" },
    null,
    { firebaseUid: "owner-b", generation: "epoch-b" },
  ]);
});
it("a reentrant newer owner publication cannot be followed by the older retirement event", async () => {
  const { native } = fixture(),
    host = await HostContext.initialize(native, "0.1.0", 1),
    observed: unknown[] = [],
    owner = { firebaseUid: "owner-b", generation: "epoch-b" };
  let newer: Promise<void> | undefined;
  host.onAccountScope((scope) => {
    if (scope === null) newer = host.accountState.publishScope(owner);
    return Promise.resolve();
  });
  host.onAccountScope(async (scope) => {
    observed.push(scope);
  });
  await host.accountState.publishScope(null);
  await newer;
  expect(host.accountScope()).toEqual(owner);
  expect(observed).toEqual([owner]);
});
it("keeps preparation journals separate from credentials and releases the exact native mutex once", async () => {
  const { native, secrets } = fixture();
  const host = await HostContext.initialize(native, "0.1.0", 1);
  await host.prepareJournal.write({
    version: 1,
    transaction: "00000000-0000-4000-8000-000000000001",
    target: "a".repeat(64),
    sid: host.identity.sid,
    state: "running",
    completed: [],
  });
  expect(((await host.prepareJournal.read()) as { state: string }).state).toBe(
    "running",
  );
  expect(secrets.has("credential")).toBe(false);
  const lease = await host.prepareLease({
    identity: "a".repeat(64),
    sid: host.identity.sid,
  });
  await Promise.all([lease!.release(), lease!.release()]);
  await lease!.release();
  expect(native.releaseMutex).toHaveBeenCalledOnce();
  secrets.set("prepare_journal", Buffer.from("corrupt"));
  await expect(host.prepareJournal.read()).rejects.toThrow("JOURNAL_CORRUPT");
});
it("rejects foreign preparation identity before requesting a lock and exposes contention", async () => {
  const { native } = fixture();
  native.acquireMutex = vi.fn(async () => null);
  const host = await HostContext.initialize(native, "0.1.0", 1);
  await expect(
    host.prepareLease({ identity: "a".repeat(64), sid: "S-1-12-1-1-2-3-4" }),
  ).rejects.toThrow("INTEGRITY_INVALID");
  expect(native.acquireMutex).not.toHaveBeenCalled();
  expect(
    await host.prepareLease({
      identity: "a".repeat(64),
      sid: host.identity.sid,
    }),
  ).toBeNull();
});
