import { PACKAGE_DATA_ROOT_NAMES } from "../../shared/package-build-profile.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createConsumerNativeTransport,
  WindowsConsumerNative,
  sameConsumerProcess,
  type ConsumerMutexLease,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  configureWorkerResourceTrust,
  loadPackagedDesktopBuild,
} from "../browser/package-trust.js";
import { HostContext } from "../host-context.js";
import {
  WindowsPreparationOperations,
  parseReadyReceipt,
} from "../prepare/operations.js";
import { loadPreparationBundle } from "../prepare/bundle.js";
import { QualificationCleanupUnconfirmed } from "../prepare/qualification-runner.js";
import { parseInstalledReadyMetadata } from "../update/installed-runtime.js";
import { loadActiveConsumerPreparationBundle } from "../update/loader.js";
import { inspectConsumerUpdateStartup } from "../update/storage.js";
import { inspectWindowsFleetRecovery } from "../fleet/recovery.js";
import { VaultFleetStore, fleetRecordAuthority } from "../fleet/store.js";
import {
  readOperationalFleetIdentity,
  readApprovedFleetGpuSelection,
  fleetGpuReadyAligned,
} from "../fleet/active-runtime.js";
import { refreshApprovedFleetRuntime } from "../fleet/update-preparation.js";
import { VaultSessionStateStore } from "./state-store.js";
import { SessionClient } from "./control.js";
import {
  runLoginWorkerBootstrap,
  type LoginWorkerEligibility,
  type LoginWorkerResult,
} from "./login-worker.js";

const HASH = /^[a-f0-9]{64}$/u,
  UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
async function bounded(path: string, limit: number): Promise<Buffer> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > limit
  )
    throw new Error("SESSION_INTEGRITY_INVALID");
  const bytes = await readFile(path);
  if (bytes.length !== stat.size) throw new Error("SESSION_INTEGRITY_INVALID");
  return bytes;
}
/** A removal marker is immutable enrollment authority, not an alternative intent writer. */
export function parseLoginWorkerRemoval(
  value: unknown,
  machineId: string | null,
  authority: string,
): boolean {
  const row = value as Record<string, unknown>;
  if (
    !row ||
    Array.isArray(row) ||
    Object.keys(row).sort().join() !==
      "authority,machineId,removedAt,version" ||
    row.version !== 1 ||
    typeof row.machineId !== "string" ||
    !UUID.test(row.machineId) ||
    typeof row.authority !== "string" ||
    !HASH.test(row.authority) ||
    typeof row.removedAt !== "string" ||
    row.removedAt.length > 40 ||
    !Number.isFinite(Date.parse(row.removedAt)) ||
    Date.parse(row.removedAt) > Date.now()
  )
    throw new Error("FLEET_INTEGRITY_INVALID");
  if (row.machineId !== machineId || row.authority !== authority)
    throw new Error("FLEET_INTEGRITY_INVALID");
  return true;
}
/** Actual independent Node entry. No Electron/account singleton, browser registration,
 * download, enrollment or token authority is instantiated here. The signed shim holds
 * the launch graph and public capsule immutable until this entry returns. */
export async function runIndependentLoginWorker(
  signal: AbortSignal,
): Promise<LoginWorkerResult> {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.argv[2] !== "--login-worker" ||
    process.argv.length !== 3
  )
    throw new Error("SESSION_CONTEXT_INVALID");
  const releaseRoot = win32.dirname(
      win32.dirname(win32.dirname(process.execPath)),
    ),
    release = win32.basename(releaseRoot),
    helperPath = win32.join(
      releaseRoot,
      "runtime",
      "native",
      "musicmute-native.exe",
    );
  if (
    !HASH.test(release) ||
    win32.resolve(process.argv[1] ?? "").toLowerCase() !==
      win32.join(releaseRoot, "agent", "login-worker.cjs").toLowerCase()
  )
    throw new Error("SESSION_CONTEXT_INVALID");
  const helperBytes = await bounded(helperPath, 16 * 1024 ** 2),
    native = new WindowsConsumerNative(
      await createConsumerNativeTransport(
        helperPath,
        createHash("sha256").update(helperBytes).digest("hex"),
      ),
    );
  const lifetime = new AbortController(),
    linked = AbortSignal.any([signal, lifetime.signal]);
  const hooks = [
    native.onClosed(() => lifetime.abort()),
    native.onEvent((event) => {
      if (event.kind === "session" && event.event === "ending")
        lifetime.abort();
    }),
  ];
  try {
    const proof = await native.verifyWorkerLoginPeer(),
      identity = await native.identity();
    const caller = await native.processIdentity(process.pid);
    if (
      !caller ||
      caller.sid !== identity.sid ||
      caller.sessionId !== identity.sessionId
    )
      throw new Error("PEER_DENIED");
    const personalRoot = win32.join(
        identity.localAppData,
        PACKAGE_DATA_ROOT_NAMES.personal,
      ),
      capsuleRelative = `login\\${proof.capsuleSha256}`;
    if (
      proof.release !== release ||
      win32.resolve(proof.resourcesRoot).toLowerCase() !==
        win32.join(personalRoot, capsuleRelative, "resources").toLowerCase()
    )
      throw new Error("SESSION_INTEGRITY_INVALID");
    await native.validatePath(
      "personal",
      `${capsuleRelative}\\capsule.json`,
      "file",
    );
    await configureWorkerResourceTrust(
      proof.resourcesRoot,
      await bounded(
        win32.join(personalRoot, capsuleRelative, "capsule.json"),
        8192,
      ),
      proof.capsuleSha256,
    );
    const build = await loadPackagedDesktopBuild(proof.resourcesRoot),
      states = new VaultSessionStateStore(native),
      fleet = new VaultFleetStore(native, identity.sid);
    let host: HostContext | undefined,
      operations: WindowsPreparationOperations | undefined,
      prepare: ConsumerMutexLease | null = null,
      target:
        Awaited<ReturnType<WindowsPreparationOperations["target"]>> | undefined;
    const eligibility = async (): Promise<LoginWorkerEligibility | null> => {
      const record = await fleet.read(),
        state = await states.read();
      if (!record || record.phase !== "complete" || !state) return null;
      if (state.sid !== identity.sid)
        throw new Error("SESSION_IDENTITY_CONFLICT");
      const authority = fleetRecordAuthority(record),
        removedBytes = await native.vaultRead("fleet", "removed");
      let removed = false;
      if (removedBytes)
        try {
          removed = parseLoginWorkerRemoval(
            parseStrictJson(
              new TextDecoder("utf-8", { fatal: true }).decode(removedBytes),
              4096,
            ),
            record.machineId,
            authority,
          );
        } finally {
          removedBytes.fill(0);
        }
      return { state, authority, removed };
    };
    const initialize = async () => {
      if (host && operations && target) return { host, operations, target };
      // A prepared installation already has this metadata. Login never creates
      // a new account installation or enrollment while restoring the worker.
      const installation = await native.vaultRead("account", "installation");
      if (!installation) throw new Error("SESSION_INTEGRITY_INVALID");
      installation.fill(0);
      host = await HostContext.initialize(
        native,
        build.appVersion,
        build.buildNumber,
      );
      const context = host;
      operations = new WindowsPreparationOperations(
        context,
        proof.resourcesRoot,
        async () => {
          throw new Error("SESSION_CONTEXT_INVALID");
        },
        async (minimum) => {
          const bytes = await native.vaultRead("account", "ready_receipt");
          if (!bytes) throw new Error("FLEET_PREPARE_REQUIRED");
          try {
            const installed = parseInstalledReadyMetadata(
              parseStrictJson(
                new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                32768,
              ),
              identity.sid,
            );
            return (
              (await loadActiveConsumerPreparationBundle(
                context,
                proof.resourcesRoot,
                minimum,
                installed,
              )) ??
              (await loadPreparationBundle(
                proof.resourcesRoot,
                minimum,
                new Date(),
                installed,
              ))
            );
          } finally {
            bytes.fill(0);
          }
        },
      );
      target = await operations.target(linked);
      if (target.identity !== proof.release)
        throw new Error("SESSION_INTEGRITY_INVALID");
      return { host: context, operations, target };
    };
    const current = async () => {
      const context = await initialize();
      if (!(await context.operations.cachedReady(context.target, linked)))
        return false;
      const record = await fleet.read();
      if (!record || record.phase !== "complete") return false;
      const bytes = await native.vaultRead("account", "ready_receipt");
      if (!bytes) return false;
      try {
        const parsed = parseReadyReceipt(
            parseStrictJson(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              32768,
            ),
            context.target,
            await native.bootIdentity(),
          ),
          ready = parsed.receipt;
        const active = await readOperationalFleetIdentity(native, record, {
          release: ready.release,
          manifestDigest: ready.manifestSha256,
          modelDigest: ready.modelSha256,
        });
        return fleetGpuReadyAligned(
          { bootIdentity: ready.bootIdentity, evidence: parsed.evidence },
          active,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "FLEET_PREPARE_REQUIRED"
        )
          return false;
        throw error;
      } finally {
        bytes.fill(0);
      }
    };
    return await runLoginWorkerBootstrap(
      {
        authorize: async () => {
          const latest = await native.verifyWorkerLoginPeer();
          if (JSON.stringify(latest) !== JSON.stringify(proof))
            throw new Error("PEER_DENIED");
        },
        eligibility,
        existingOwner: async () => {
          const account = await native.inspectSingletonOwner("account");
          if (account.state === "active" && !account.sameSession)
            throw new Error("WINDOWS_SESSION_ALREADY_ACTIVE");
          const owner = await native.inspectSingletonOwner("session");
          if (owner.state === "active" && !owner.sameSession)
            throw new Error("WINDOWS_SESSION_ALREADY_ACTIVE");
          return (
            owner.state === "active" &&
            !sameConsumerProcess(owner.owner, caller)
          );
        },
        recoveryPending: async () =>
          (await inspectConsumerUpdateStartup({ native })).recoveryRequired ||
          (await inspectWindowsFleetRecovery({ native, identity }))
            .recoveryRequired,
        acquireActivation: async () => {
          const lease = await native.acquireMutex("activation");
          return lease ? { release: () => native.releaseMutex(lease) } : null;
        },
        acquirePrepare: async () => {
          prepare = await native.acquireMutex("prepare");
          const lease = prepare;
          return lease
            ? {
                release: async () => {
                  await native.releaseMutex(lease);
                  prepare = null;
                },
              }
            : null;
        },
        treesIdle: () => native.workerLoginIdle(),
        prepareTreesIdle: () => native.workerLoginIdle("prepare"),
        cleanupUncertain: (error) =>
          error instanceof QualificationCleanupUnconfirmed,
        recoverUncertainCleanup: async (active) => {
          // A retained fence is never converted to a success by a later BUSY.
          // This fixed read-only certificate query combines whole-Job zero with
          // the exact guardian-controller birth retiring after its failed ACK.
          while (!(await native.workerLoginIdle("prepare"))) {
            active.throwIfAborted();
            await delay(1000, undefined, { signal: active });
          }
        },
        currentQualification: current,
        requalifyInstalled: async (active) => {
          const record = await fleet.read();
          if (!record || record.phase !== "complete")
            throw new Error("FLEET_PREPARE_REQUIRED");
          const selection = await readApprovedFleetGpuSelection(
            native,
            record,
            await native.bootIdentity(),
          );
          await (
            await initialize()
          ).operations.requalifyInstalled(active, selection);
        },
        refreshApprovedFleet: async (transaction, active) => {
          if (!prepare) throw new Error("UPDATE_MAINTENANCE_REQUIRED");
          const context = await initialize();
          await refreshApprovedFleetRuntime(
            {
              host: context.host,
              operations: context.operations,
              prepareLease: prepare,
              transaction,
              runtimeIdentity: proof.release,
            },
            active,
          );
        },
        launch: async (intent) => {
          await native.launchSessionAgent(proof.launcherSha256);
          const eventHelpers = new Set<WindowsConsumerNative>(),
            client = new SessionClient(native, async () => {
              const helper = new WindowsConsumerNative(
                await createConsumerNativeTransport(
                  helperPath,
                  createHash("sha256").update(helperBytes).digest("hex"),
                ),
              );
              eventHelpers.add(helper);
              return helper;
            }),
            deadline = Date.now() + 30000;
          let previous:
            Awaited<ReturnType<SessionClient["command"]>> | undefined;
          try {
            for (;;) {
              linked.throwIfAborted();
              try {
                const snapshot = previous
                  ? await client.waitState(
                      previous.revision,
                      previous.instance_id,
                      linked,
                    )
                  : await client.command(
                      {
                        version: 1,
                        request_id: randomUUID(),
                        action: "status",
                      },
                      linked,
                    );
                previous = snapshot;
                if (snapshot.release !== proof.release)
                  throw new Error("SESSION_INTEGRITY_INVALID");
                if (snapshot.fleet.intent !== intent) return false; // A concurrent successful intent change wins.
                if (
                  snapshot.phase === "blocked" ||
                  snapshot.fleet.phase === "blocked"
                )
                  throw new Error("FLEET_PREPARE_REQUIRED");
                if (
                  snapshot.phase === "running" &&
                  snapshot.fleet.phase === intent
                )
                  return true;
              } catch (error) {
                if (
                  !(error instanceof Error) ||
                  error.message !== "SESSION_UNAVAILABLE"
                )
                  throw error;
              }
              if (Date.now() >= deadline)
                throw new Error("SESSION_UNAVAILABLE");
              if (!previous) await delay(100, undefined, { signal: linked });
            }
          } finally {
            await Promise.allSettled(
              [...eventHelpers].map((helper) => helper.close()),
            );
          }
        },
      },
      linked,
    );
  } finally {
    for (const hook of hooks) hook();
    await native.close();
  }
}
