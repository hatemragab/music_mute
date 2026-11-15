import { PACKAGE_DATA_ROOT_NAMES } from "../shared/package-build-profile.js";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, win32 } from "node:path";
import {
  createConsumerNativeTransport,
  WindowsConsumerNative,
  type ConsumerHostIdentity,
  type ConsumerProcessIdentity,
  type ConsumerOwnedProcess,
} from "../../../worker/src/platform/windows/consumer-native.js";
import type {
  AccountSessionScope,
  AccountStatePort,
  AccountVaultPort,
  StoredCredential,
  WindowsInstallationReport,
} from "./account/account-controller.js";
import {
  PrepareFailure,
  type PrepareJournalPort,
  type PrepareLease,
  type PrepareTarget,
} from "./prepare/controller.js";
import { readPackagedResource } from "./browser/package-trust.js";
import { StoreNativeAuthority } from "./browser/store-native.js";

export type HostNativePort = Pick<
  WindowsConsumerNative,
  | "identity"
  | "bootIdentity"
  | "ensurePrivateDirectory"
  | "validatePath"
  | "openPrivateFile"
  | "vaultRead"
  | "vaultWrite"
  | "vaultDelete"
  | "acquireMutex"
  | "releaseMutex"
  | "beginCacheDeletion"
  | "commitCacheDeletion"
  | "releaseCacheDeletion"
  | "recoverCacheDeletions"
  | "removeRuntimeRepairBackup"
  | "enumerateGpus"
  | "close"
> &
  Partial<
    Pick<
      WindowsConsumerNative,
      | "processIdentity"
      | "openStoreFixtureFile"
      | "openStoreModelFile"
      | "recoverStoreModelPublication"
      | "ownedTreeExited"
      | "inferenceIdle"
      | "registerRetainedEngine"
      | "beginRetainedEngine"
      | "completeRetainedEngine"
      | "retainedEngineIdle"
      | "forgetRetainedEngine"
      | "inspectShare"
      | "discardShareWorkspace"
      | "removeChromeDiagnosticReport"
      | "recoverPersonalCleanups"
      | "discardStoragePartial"
      | "discardLibraryArtifact"
      | "discardLibraryTree"
      | "acknowledgeLibraryTreeCleanup"
      | "listLibraryCleanups"
      | "moveLocalLibraryDeletion"
      | "publishLibraryArtifact"
      | "inspectLibraryArtifactPublication"
      | "retireStorageWorkspaceMarker"
      | "retireStoreCpuWorkspaceMarker"
      | "inspectStoreCpuOperation"
      | "acknowledgeStoreCpuWorkspaceMarker"
      | "acknowledgeStorageCleanup"
      | "recoverStorageCleanups"
    >
  >;
interface InstallationRecord {
  version: 1;
  installationId: string;
  metadataRevision: number;
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// Only the actual packaged-host factory can associate a live Store helper.
// Test ports, imported receipts and ordinary HostContext.initialize callers
// cannot create or substitute executable/package authority.
const storeHostAuthorities = new WeakMap<HostContext, StoreNativeAuthority>();
function decode(bytes: Buffer): unknown {
  if (bytes.length > 16384) throw new Error("VAULT_CORRUPT");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("VAULT_CORRUPT");
  }
}
function installationRecord(value: unknown): InstallationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("VAULT_CORRUPT");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.installationId !== "string" ||
    !UUID.test(record.installationId) ||
    !Number.isSafeInteger(record.metadataRevision) ||
    (record.metadataRevision as number) < 1 ||
    Object.keys(record).length !== 3
  )
    throw new Error("VAULT_CORRUPT");
  return record as unknown as InstallationRecord;
}
export class HostContext {
  private scope: AccountSessionScope | null = null;
  private scopePublication = Symbol();
  private readonly scopeListeners = new Set<
    (scope: AccountSessionScope | null) => Promise<void>
  >();
  readonly accountVault: AccountVaultPort;
  readonly accountState: AccountStatePort;
  readonly prepareJournal: PrepareJournalPort;
  get storeAuthority(): StoreNativeAuthority | undefined {
    return storeHostAuthorities.get(this);
  }
  private constructor(
    readonly native: HostNativePort,
    readonly identity: ConsumerHostIdentity,
    readonly personalRoot: string,
    private installation: InstallationRecord,
    readonly report: WindowsInstallationReport,
  ) {
    this.prepareJournal = {
      read: async () => {
        const bytes = await native.vaultRead("account", "prepare_journal");
        if (!bytes) return null;
        try {
          return decode(bytes);
        } catch {
          throw new PrepareFailure("JOURNAL_CORRUPT");
        }
      },
      write: async (journal) => {
        const bytes = Buffer.from(JSON.stringify(journal));
        if (bytes.length > 16384) throw new PrepareFailure("JOURNAL_CORRUPT");
        await native.vaultWrite("account", "prepare_journal", bytes);
      },
    };
    this.accountVault = {
      load: async () => {
        const bytes = await native.vaultRead("account", "credential");
        return bytes ? (decode(bytes) as StoredCredential) : null;
      },
      save: (credential) =>
        native.vaultWrite(
          "account",
          "credential",
          Buffer.from(JSON.stringify(credential)),
        ),
      remove: () => native.vaultDelete("account", "credential"),
    };
    this.accountState = {
      readSignedOut: async () => {
        const bytes = await native.vaultRead("account", "signout_state");
        if (!bytes) return false;
        const value = decode(bytes);
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          !("version" in value) ||
          value.version !== 1 ||
          !("signedOut" in value) ||
          typeof value.signedOut !== "boolean" ||
          Object.keys(value).length !== 2
        )
          throw new Error("VAULT_CORRUPT");
        return value.signedOut;
      },
      writeSignedOut: (signedOut) =>
        native.vaultWrite(
          "account",
          "signout_state",
          Buffer.from(JSON.stringify({ version: 1, signedOut })),
        ),
      publishScope: async (scope) => {
        this.scope = scope ? { ...scope } : null;
        const publication = (this.scopePublication = Symbol()),
          published = this.accountScope();
        // Start every current-owner fence before awaiting cleanup. A throwing
        // consumer must neither skip later fences nor release native lifetime
        // while another admitted teardown is still pending.
        const settlements = [...this.scopeListeners].map((listener) => {
          // A reentrant newer publication has already started its own fences;
          // never deliver this older null/owner event after that new authority.
          if (publication !== this.scopePublication) return Promise.resolve();
          try {
            return Promise.resolve(
              listener(published ? { ...published } : null),
            );
          } catch {
            return Promise.reject(new Error("ACCOUNT_SCOPE_TRANSITION_FAILED"));
          }
        });
        if (
          (await Promise.allSettled(settlements)).some(
            (result) => result.status === "rejected",
          )
        )
          throw new Error("ACCOUNT_SCOPE_TRANSITION_FAILED");
      },
      saveMetadataRevision: async (revision) => {
        if (
          !Number.isSafeInteger(revision) ||
          revision <= this.installation.metadataRevision
        )
          throw new Error("INVALID_REVISION");
        const next = { ...this.installation, metadataRevision: revision };
        await native.vaultWrite(
          "account",
          "installation",
          Buffer.from(JSON.stringify(next)),
        );
        this.installation = next;
        this.report.metadataRevision = revision;
      },
    };
  }
  static async initialize(
    native: HostNativePort,
    appVersion: string,
    buildNumber: number,
  ): Promise<HostContext> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,31}$/.test(appVersion) ||
      !Number.isSafeInteger(buildNumber) ||
      buildNumber < 1
    )
      throw new Error("PACKAGE_METADATA_INVALID");
    const identity = await native.identity();
    const personalRoot = await native.ensurePrivateDirectory("personal");
    if (
      win32.normalize(personalRoot).toLowerCase() !==
      win32
        .join(identity.localAppData, PACKAGE_DATA_ROOT_NAMES.personal)
        .toLowerCase()
    )
      throw new Error("PATH_UNSAFE");
    const bytes = await native.vaultRead("account", "installation");
    const record = bytes
      ? installationRecord(decode(bytes))
      : {
          version: 1 as const,
          installationId: randomUUID(),
          metadataRevision: 1,
        };
    if (!bytes)
      await native.vaultWrite(
        "account",
        "installation",
        Buffer.from(JSON.stringify(record)),
      );
    return new HostContext(native, identity, personalRoot, record, {
      installationId: record.installationId,
      appVersion,
      buildNumber,
      metadataRevision: record.metadataRevision,
      osVersion: `10.0.${identity.osBuild}`,
    });
  }
  accountScope(): AccountSessionScope | null {
    return this.scope ? { ...this.scope } : null;
  }
  onAccountScope(
    listener: (scope: AccountSessionScope | null) => Promise<void>,
  ): () => void {
    this.scopeListeners.add(listener);
    return () => {
      this.scopeListeners.delete(listener);
    };
  }
  async directory(relativePath: string): Promise<string> {
    return this.native.ensurePrivateDirectory("personal", relativePath);
  }
  async prepareLease(target: PrepareTarget): Promise<PrepareLease | null> {
    if (target.sid !== this.identity.sid)
      throw new PrepareFailure("INTEGRITY_INVALID");
    const lease = await this.native.acquireMutex("prepare");
    if (!lease) return null;
    if (
      lease.identity.sid !== this.identity.sid ||
      lease.identity.sessionId !== this.identity.sessionId
    ) {
      await this.native.releaseMutex(lease);
      throw new PrepareFailure("INTEGRITY_INVALID");
    }
    let released = false;
    let pending: Promise<void> | undefined;
    return {
      release: () => {
        if (released) return Promise.resolve();
        pending ??= this.native
          .releaseMutex(lease)
          .then(() => {
            released = true;
          })
          .finally(() => {
            pending = undefined;
          });
        return pending;
      },
    };
  }
  close(): Promise<void> {
    return this.native.close();
  }
  /** Storage pins name their actual consuming process, including its native birth time. */
  processIdentity(pid: number): Promise<ConsumerProcessIdentity | null> {
    if (!this.native.processIdentity)
      throw new Error("HELPER_INTEGRITY_INVALID");
    return this.native.processIdentity(pid);
  }
  ownedTreeExited(owner: ConsumerOwnedProcess): Promise<boolean> {
    if (!this.native.ownedTreeExited)
      throw new Error("HELPER_INTEGRITY_INVALID");
    return this.native.ownedTreeExited(owner);
  }
}

/** The compiled native binary and its build-generated digest ship with the signed app. */
export async function openWindowsHost(
  resourcesRoot: string,
  appVersion: string,
  buildNumber: number,
): Promise<HostContext> {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("UNSUPPORTED_HOST");
  if (
    (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore ===
    true
  ) {
    const authority = await StoreNativeAuthority.open();
    try {
      if (
        win32.resolve(resourcesRoot).toLowerCase() !==
          win32
            .join(
              authority.receipt.package.installedLocation,
              "app",
              "resources",
            )
            .toLowerCase() ||
        appVersion !== authority.resourceIndex.appVersion ||
        buildNumber !== authority.resourceIndex.buildNumber
      )
        throw new Error("PACKAGE_METADATA_INVALID");
      const native = await authority.openGuiDataNative();
      const context = await HostContext.initialize(
        native,
        appVersion,
        buildNumber,
      );
      storeHostAuthorities.set(context, authority);
      return context;
    } catch (error) {
      await authority.close();
      throw error;
    }
  }
  const manifestPath = join(resourcesRoot, "native", "manifest.json");
  const stat = await lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024)
    throw new Error("HELPER_INTEGRITY_INVALID");
  const manifest = JSON.parse(
    (await readPackagedResource(manifestPath, 1024)).toString("utf8"),
  ) as Record<string, unknown>;
  if (
    manifest.version !== 1 ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    Object.keys(manifest).length !== 2
  )
    throw new Error("HELPER_INTEGRITY_INVALID");
  const native = new WindowsConsumerNative(
    await createConsumerNativeTransport(
      join(resourcesRoot, "native", "musicmute-native.exe"),
      manifest.sha256,
    ),
  );
  try {
    return await HostContext.initialize(native, appVersion, buildNumber);
  } catch (error) {
    await native.close();
    throw error;
  }
}
