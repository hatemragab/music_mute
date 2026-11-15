import { readdir } from "node:fs/promises";
import { join, win32 } from "node:path";
import { verifyWindowsRelease } from "../../../../worker/src/platform/windows/release-manifest.js";
import { compareWorkerReleaseVersions } from "../../../../worker/src/platform/shared/release-version.js";
import {
  WindowsConsumerNative,
  createConsumerNativeTransport,
  sameConsumerProcess,
  type ConsumerMutexLease,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import type { HostContext } from "../host-context.js";
import { LibraryPins } from "../library/pins.js";
import { WindowsOutboxStore } from "../outbox/store.js";
import { loadPreparationBundle } from "../prepare/bundle.js";
import {
  WindowsPreparationOperations,
  parseReadyReceipt,
  type ReadyReceipt,
} from "../prepare/operations.js";
import { PREPARE_STAGES } from "../../shared/prepare-contracts.js";
import {
  readPrivateBytes,
  writePrivateAtomic,
  privateFingerprint,
  verifyPrivateFile,
} from "../prepare/private-files.js";
import { activateDesktopSession } from "../session/desktop-client.js";
import { SessionClient } from "../session/control.js";
import { VaultSessionStateStore } from "../session/state-store.js";
import { createSessionMaintenancePort } from "../session/maintenance.js";
import { createSessionForcePort } from "../session/force.js";
import {
  registerBrowserIntegration,
  verifyBrowserIntegration,
} from "../browser/registration.js";
import type {
  ConsumerUpdateMetadata,
  ConsumerVersionSet,
  ConsumerUpdateSource,
} from "../../shared/update-contracts.js";
import {
  ConsumerUpdateController,
  parseConsumerUpdateState,
  consumerUpdateJournalSource,
} from "./controller.js";
import { ConsumerUpdateStager, createConsumerUpdateStore } from "./storage.js";
import {
  parseInstalledReadyMetadata,
  type InstalledReadyMetadata,
} from "./installed-runtime.js";
import {
  consumerUpdateIdentity,
  fetchConsumerUpdate,
  loadConsumerUpdateTrust,
  verifyConsumerUpdate,
  consumerUpdateSourceDescriptor,
} from "./metadata.js";
import {
  consumerPreparationBundle,
  loadActiveConsumerPreparationBundle,
  type ActiveConsumerUpdate,
} from "./loader.js";
import { ConsumerBackupRetention } from "./retention.js";
import {
  ConsumerModelArchive,
  parseUpdateModelBlob,
  type UpdateModelBlob,
} from "./model-archive.js";
import { refreshFleetAfterConsumerUpdate } from "../fleet/update-preparation.js";
import { readActiveFleetIdentity } from "../fleet/active-runtime.js";
import { fleetRecordAuthority, VaultFleetStore } from "../fleet/store.js";
import { resolveQualifiedGpuIdentity } from "../../../../worker/src/enrollment/report-builder.js";
import {
  ConsumerInstallerCoordinator,
  consumerInstallerPin,
} from "./installer.js";
import { readPackagedResource } from "../browser/package-trust.js";

const FIELDS = {
  ready: "ready_receipt",
  sequence: "runtime_sequence",
  active: "consumer_update_active",
  bootstrap: "agent_bootstrap",
  startup: "startup_receipt",
  prepare: "prepare_journal",
  fleetRuntime: "active_runtime",
  fleetCapacity: "capacity",
} as const;
interface Backup {
  version: 2;
  identity: string;
  previous: ConsumerVersionSet;
  fields: Record<keyof typeof FIELDS, boolean>;
  configuration: boolean;
  model: UpdateModelBlob | null;
  fleetAuthority: string | null;
}
const fieldNamespace = (field: string): "fleet" | "account" =>
  ["bootstrap", "fleetRuntime", "fleetCapacity"].includes(field)
    ? "fleet"
    : "account";
export interface ConsumerUpdateActivityPort {
  /** Fence new cloud/browser/file intake and prove real headless/media consumers idle. */
  acquire(
    transaction: string,
    signal: AbortSignal,
  ): Promise<{
    assertIdle(signal: AbortSignal): Promise<void>;
    release(): Promise<void>;
    /** Wait for exact retired account/proxy/consumer process identities. */
    commit(): Promise<void>;
  }>;
}
/** Authorize only the already running exact certified installer behind this live update.
 * This assists its existing maintenance fence; it never launches or acquires another lease. */
export async function authorizeConsumerInstallerAssistance(options: {
  host: HostContext;
  resourcesRoot: string;
  native: WindowsConsumerNative;
  receipt: { issuer: ConsumerProcessIdentity; certificateNonce: string | null };
  signal: AbortSignal;
}): Promise<{ transaction: string; identity: string } | null> {
  const { host, native, receipt, signal } = options;
  signal.throwIfAborted();
  try {
    if (
      !receipt.certificateNonce ||
      receipt.issuer.sid !== host.identity.sid ||
      receipt.issuer.sessionId !== host.identity.sessionId
    )
      return null;
    const state = await createConsumerUpdateStore(host).read(),
      journal = state?.journal;
    if (!journal || !["activating", "restart-required"].includes(journal.phase))
      return null;
    const metadata = verifyConsumerUpdate(
      journal.signed,
      await loadConsumerUpdateTrust(options.resourcesRoot),
      state!.highestSequence,
      new Date(journal.startedAt),
    );
    if (consumerUpdateIdentity(metadata) !== journal.identity) return null;
    const attempt = await new ConsumerInstallerCoordinator(
        host.native,
        native,
      ).readAttempt(),
      pin = consumerInstallerPin(metadata);
    if (
      !attempt ||
      attempt.pin.identity !== pin.identity ||
      Object.keys(pin).some(
        (key) =>
          attempt.pin[key as keyof typeof pin] !== pin[key as keyof typeof pin],
      ) ||
      attempt.app.version !== metadata.app.version ||
      attempt.app.sha256 !== metadata.app.payloadSha256 ||
      !["launching", "running"].includes(attempt.phase)
    )
      return null;
    const status = await native.inspectInstallerLaunch(pin);
    signal.throwIfAborted();
    if (
      status.state !== "running" ||
      !status.certificate.process ||
      !status.certificate.monitor ||
      status.certificate.nonce !== receipt.certificateNonce ||
      (attempt.nonce !== null && attempt.nonce !== status.certificate.nonce) ||
      !sameConsumerProcess(receipt.issuer, status.certificate.process)
    )
      return null;
    return { transaction: journal.transaction, identity: journal.identity };
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}
async function jsonResource(path: string): Promise<Record<string, unknown>> {
  const bytes = await readPackagedResource(path, 16384);
  const row = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new Error("UPDATE_UNAVAILABLE");
  return row;
}
function backupKey(identity: string, field: string): string {
  return `up_${identity.slice(0, 40)}_${field}`;
}
export async function openWindowsConsumerUpdateNative(
  host: HostContext,
  resourcesRoot: string,
): Promise<WindowsConsumerNative> {
  const manifest = await jsonResource(
    join(resourcesRoot, "native", "manifest.json"),
  );
  if (
    Object.keys(manifest).sort().join() !== "sha256,version" ||
    manifest.version !== 1 ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.sha256)
  )
    throw new Error("UPDATE_UNAVAILABLE");
  const native = new WindowsConsumerNative(
    await createConsumerNativeTransport(
      join(resourcesRoot, "native", "musicmute-native.exe"),
      manifest.sha256,
    ),
  );
  try {
    const identity = await native.identity();
    if (
      identity.sid !== host.identity.sid ||
      identity.sessionId !== host.identity.sessionId
    )
      throw new Error("UPDATE_UNAVAILABLE");
    return native;
  } catch (error) {
    await native.close();
    throw error;
  }
}
async function ready(host: HostContext): Promise<ReadyReceipt> {
  const bytes = await host.native.vaultRead("account", "ready_receipt");
  if (!bytes) throw new Error("UPDATE_PREPARE_REQUIRED");
  try {
    const row = JSON.parse(bytes.toString("utf8")) as { target: string };
    return parseReadyReceipt(
      row,
      {
        sid: host.identity.sid,
        identity: row.target,
      },
      await host.native.bootIdentity(),
    ).receipt;
  } finally {
    bytes.fill(0);
  }
}
async function appIdentity(resources: string) {
  const row = await jsonResource(join(resources, "app-update-identity.json"));
  if (
    Object.keys(row).sort().join() !== "appVersion,payloadSha256,version" ||
    row.version !== 1 ||
    typeof row.appVersion !== "string" ||
    typeof row.payloadSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.payloadSha256)
  )
    throw new Error("UPDATE_UNAVAILABLE");
  return { version: row.appVersion, sha256: row.payloadSha256 };
}
/** Source-backed consumer install composition. Missing approved packaging is unavailable, never a fake current release. */
export async function createWindowsConsumerUpdater(options: {
  host: HostContext;
  resourcesRoot: string;
  native: WindowsConsumerNative;
  session?: SessionClient;
  consumerActivity: ConsumerUpdateActivityPort;
  /** Main must close Electron only after independently launched installer acknowledgement. */ onInstallerStarted(): Promise<void>;
  onSessionRetired(): Promise<void>;
  fetch?: typeof fetch;
}): Promise<ConsumerUpdateController> {
  const { host, resourcesRoot, native } = options,
    trust = await loadConsumerUpdateTrust(resourcesRoot).catch(() => {
      throw new Error("UPDATE_UNAVAILABLE");
    }),
    app = await appIdentity(resourcesRoot).catch(() => {
      throw new Error("UPDATE_UNAVAILABLE");
    }),
    store = createConsumerUpdateStore(host),
    stager = new ConsumerUpdateStager(host, trust, options.fetch),
    session = options.session ?? new SessionClient(native),
    maintenance = createSessionMaintenancePort(session);
  const pins = new LibraryPins(host, (pid) => native.processIdentity(pid)),
    outbox = new WindowsOutboxStore(host),
    backupRetention = new ConsumerBackupRetention(host.native),
    modelArchive = new ConsumerModelArchive(host);
  const installer = new ConsumerInstallerCoordinator(host.native, native);
  let heldPrepare: ConsumerMutexLease | null = null;
  let retireSession: (() => Promise<void>) | null = null;
  let heldActivity: Awaited<
    ReturnType<ConsumerUpdateActivityPort["acquire"]>
  > | null = null;
  let latest: unknown, rollbackMetadata: ConsumerUpdateMetadata | undefined;
  const sourceTrust = (source: ConsumerUpdateSource) =>
    source === "app"
      ? Promise.resolve(trust)
      : loadConsumerUpdateTrust(resourcesRoot, source).catch(() => {
          throw new Error("UPDATE_CATALOG_UNAVAILABLE");
        });
  const journalSource = async () => {
    const journal = (await store.read())?.journal;
    return journal ? consumerUpdateJournalSource(journal) : "app";
  };
  const currentStager = async () =>
    new ConsumerUpdateStager(
      host,
      await sourceTrust(await journalSource()),
      options.fetch,
    );
  let installedOperations: WindowsPreparationOperations | undefined;
  const retention = () => backupRetention.read();
  const optionalReady = async (): Promise<InstalledReadyMetadata | null> => {
    const raw = await host.native.vaultRead("account", "ready_receipt");
    if (!raw) return null;
    try {
      if (raw.length > 32768) throw new Error("UPDATE_STATE_INVALID");
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      );
      return parseInstalledReadyMetadata(value, host.identity.sid);
    } finally {
      raw.fill(0);
    }
  };
  const capturedPrevious = async (): Promise<ConsumerVersionSet> =>
    (await store.read())?.journal?.previous ?? (await current());
  const appOnly = async () => {
    const journal = (await store.read())?.journal;
    return (
      journal?.scope === "app-only" ||
      (journal?.scope === undefined &&
        (await capturedPrevious()).runtime === null)
    );
  };
  const components = async () =>
    (await journalSource()) === "catalog"
      ? (["runtime", "model"] as const)
      : (await appOnly())
        ? (["app"] as const)
        : (["app", "runtime", "model"] as const);
  const current = async (): Promise<ConsumerVersionSet> => {
    const proof = await optionalReady();
    if (!proof) {
      installedOperations = undefined;
      return { app, runtime: null, model: null };
    }
    const active = await loadActiveConsumerPreparationBundle(
        host,
        resourcesRoot,
        0,
        proof,
      ),
      bundle =
        active ??
        (await loadPreparationBundle(resourcesRoot, 0, new Date(), proof));
    const inspected = new WindowsPreparationOperations(
        host,
        resourcesRoot,
        async () => false,
        async () => bundle,
      ),
      inventory = await inspected.snapshotMediaTools(
        new AbortController().signal,
      ),
      model = await verifyPrivateFile(
        host,
        `models\\${MODEL.filename}`,
        MODEL.bytes,
        new AbortController().signal,
      );
    if (
      inventory.manifestSha256 !== proof.manifestSha256 ||
      model.sha256 !== proof.modelSha256
    )
      throw new Error("UPDATE_STATE_INVALID");
    installedOperations = inspected;
    let modelVersion = "1.0.0";
    const raw = await host.native.vaultRead(
      "account",
      "consumer_update_active",
    );
    if (raw) {
      try {
        const row = JSON.parse(raw.toString("utf8")) as ActiveConsumerUpdate;
        if (row.kind === "consumer")
          modelVersion = verifyConsumerUpdate(
            row.signed,
            await sourceTrust(row.source ?? "app"),
            0,
            new Date(row.activatedAt),
          ).model.version;
      } finally {
        raw.fill(0);
      }
    }
    return {
      app,
      runtime: {
        version: bundle.metadata.releaseVersion,
        sha256: bundle.metadata.release.sha256,
      },
      model: { version: modelVersion, sha256: proof.modelSha256 },
    };
  };
  const saveBackup = async (
    metadata: ConsumerUpdateMetadata,
    signal: AbortSignal,
  ) => {
    const identity = consumerUpdateIdentity(metadata),
      existing = await host.native.vaultRead(
        "account",
        backupKey(identity, "index"),
      );
    if (existing) {
      try {
        const row = JSON.parse(existing.toString("utf8")) as Backup;
        const journal = (await store.read())?.journal;
        if (
          row.version !== 2 ||
          row.identity !== identity ||
          !journal ||
          journal.identity !== identity ||
          JSON.stringify(row.previous) !== JSON.stringify(journal.previous) ||
          Object.keys(row).sort().join() !==
            "configuration,fields,fleetAuthority,identity,model,previous,version" ||
          !row.fields ||
          Object.keys(row.fields).sort().join() !==
            Object.keys(FIELDS).sort().join() ||
          Object.values(row.fields).some(
            (value) => typeof value !== "boolean",
          ) ||
          typeof row.configuration !== "boolean" ||
          (row.model?.sha256 ?? null) !== (row.previous.model?.sha256 ?? null)
        )
          throw new Error("UPDATE_STATE_INVALID");
        if (row.model) parseUpdateModelBlob(row.model);
        await backupRetention.reserve(identity);
        if (row.model)
          await modelArchive.verify(
            `updates\\backups\\${identity}\\model.onnx`,
            row.model,
            signal,
          );
        return;
      } finally {
        existing.fill(0);
      }
    }
    const proof = await optionalReady(),
      previous = await capturedPrevious();
    if ((proof === null) !== (previous.model === null))
      throw new Error("UPDATE_STATE_INVALID");
    const model = proof
      ? parseUpdateModelBlob({
          bytes: proof.modelFingerprint.bytes,
          sha256: proof.modelSha256,
        })
      : null;
    if ((previous.model?.sha256 ?? null) !== (model?.sha256 ?? null))
      throw new Error("UPDATE_STATE_INVALID");
    if (model) await modelArchive.reserveSpace(model);
    // A partial capture remains tracked and bounded across crashes. No packet precedes this reservation.
    await backupRetention.reserve(identity);
    if (model) await modelArchive.capture(identity, model, signal);
    const fleet = await new VaultFleetStore(
      host.native,
      host.identity.sid,
    ).read();
    const index: Backup = {
      version: 2,
      identity,
      previous,
      fields: {} as Backup["fields"],
      configuration: false,
      model,
      fleetAuthority: fleet ? fleetRecordAuthority(fleet) : null,
    };
    for (const [field, key] of Object.entries(FIELDS)) {
      const namespace = fieldNamespace(field),
        bytes = await host.native.vaultRead(namespace, key);
      index.fields[field as keyof typeof FIELDS] = !!bytes;
      if (bytes) {
        try {
          if (bytes.length > 16384) throw new Error("UPDATE_STATE_INVALID");
          await host.native.vaultWrite(
            "account",
            backupKey(identity, field),
            bytes,
          );
        } finally {
          bytes.fill(0);
        }
      }
    }
    try {
      const config = await readPrivateBytes(
        host,
        "consumer-config.json",
        16384,
      );
      try {
        await host.native.vaultWrite(
          "account",
          backupKey(identity, "config"),
          config,
        );
        index.configuration = true;
      } finally {
        config.fill(0);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Seed the exact initial signed worker bundle as an explicit recovery target.
    if (proof && !index.fields.active) {
      const proof = await optionalReady();
      if (!proof) throw new Error("UPDATE_STATE_INVALID");
      const signed = await jsonResource(
          join(resourcesRoot, "runtime", "runtime-metadata.json"),
        ),
        record: ActiveConsumerUpdate = {
          version: 1,
          kind: "worker",
          signed,
          target: proof.target,
          activatedAt: proof.activatedAt,
          recoveryOf: identity,
        };
      await host.native.vaultWrite(
        "account",
        backupKey(identity, "active"),
        Buffer.from(JSON.stringify(record)),
      );
      index.fields.active = true;
    }
    const currentFleet = await new VaultFleetStore(
      host.native,
      host.identity.sid,
    ).read();
    if (
      (currentFleet ? fleetRecordAuthority(currentFleet) : null) !==
      index.fleetAuthority
    )
      throw new Error("UPDATE_FLEET_CHANGED");
    await host.native.vaultWrite(
      "account",
      backupKey(identity, "index"),
      Buffer.from(JSON.stringify(index)),
    );
  };
  const operations = (metadata: ConsumerUpdateMetadata) =>
    new WindowsPreparationOperations(
      host,
      resourcesRoot,
      () => registerBrowserIntegration(host, resourcesRoot),
      async () => consumerPreparationBundle(host, metadata),
    );
  const preserve = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const fleet = await new VaultFleetStore(
      host.native,
      host.identity.sid,
    ).read();
    if (fleet && !["complete", "revoked"].includes(fleet.phase))
      throw new Error("UPDATE_FLEET_ONBOARDING_PENDING");
    if (await pins.hasLiveConsumers()) throw new Error("UPDATE_BUSY");
    const records = await outbox.list();
    if (
      records.some(
        (row) =>
          ["capturing", "saving"].includes(row.state) ||
          (!row.captured && !row.copiesReleased),
      )
    )
      throw new Error("UPDATE_BUSY");
  };
  const launched = (metadata: ConsumerUpdateMetadata) =>
    installer.launch(metadata);
  const metadataFromJournal = async () => {
    const state = parseConsumerUpdateState(await store.read());
    if (!state.journal) throw new Error("UPDATE_STATE_INVALID");
    return verifyConsumerUpdate(
      state.journal.signed,
      await sourceTrust(consumerUpdateJournalSource(state.journal)),
      state.highestSequence,
      new Date(state.journal.startedAt),
    );
  };
  return new ConsumerUpdateController({
    trust,
    sourceTrust,
    store,
    current,
    operationScope: async () => {
      await current();
      try {
        if (!installedOperations) return "app-only";
        await installedOperations.snapshotReady(new AbortController().signal);
        return "prepared";
      } catch {
        return "app-only";
      }
    },
    candidate: async (signal, source = "app") => {
      const selectedTrust = await sourceTrust(source);
      const response = await fetchConsumerUpdate(
        selectedTrust,
        signal,
        options.fetch,
      );
      const catalog = response as { current?: unknown; rollback?: unknown[] };
      latest =
        catalog &&
        typeof catalog === "object" &&
        Object.keys(catalog).sort().join() === "current,rollback"
          ? catalog.current
          : response;
      if (
        catalog?.current &&
        Array.isArray(catalog.rollback) &&
        catalog.rollback.length <= 2
      ) {
        for (const value of catalog.rollback) {
          const stamp = (value as { metadata?: { publishedAt?: string } })
            ?.metadata?.publishedAt;
          const metadata = verifyConsumerUpdate(
            value,
            selectedTrust,
            0,
            new Date(Date.parse(stamp ?? "") + 1000),
          );
          if (
            metadata.app.version === app.version &&
            metadata.app.payloadSha256 === app.sha256
          ) {
            rollbackMetadata = metadata;
            await host.native.vaultWrite(
              "account",
              "consumer_update_rollback_app",
              Buffer.from(JSON.stringify({ version: 1, signed: value })),
            );
            break;
          }
        }
      }
      return latest;
    },
    lock: async () => {
      const lease = await native.acquireMutex("prepare");
      heldPrepare = lease;
      return lease
        ? {
            release: async () => {
              await native.releaseMutex(lease);
              heldPrepare = null;
            },
          }
        : null;
    },
    stage: async (metadata, transaction, signal) => {
      await (
        await currentStager()
      ).stage(metadata, transaction, signal, await components());
      if (metadata.app.payloadSha256 !== app.sha256) {
        if (!rollbackMetadata) {
          const bytes = await host.native.vaultRead(
            "account",
            "consumer_update_rollback_app",
          );
          if (bytes) {
            try {
              const row = JSON.parse(bytes.toString("utf8")) as {
                signed: { metadata: { publishedAt: string } };
              };
              rollbackMetadata = verifyConsumerUpdate(
                row.signed,
                trust,
                0,
                new Date(Date.parse(row.signed.metadata.publishedAt) + 1000),
              );
            } finally {
              bytes.fill(0);
            }
          }
        }
        if (
          !rollbackMetadata ||
          rollbackMetadata.app.version !== app.version ||
          rollbackMetadata.app.payloadSha256 !== app.sha256
        )
          throw new Error("UPDATE_ROLLBACK_UNAVAILABLE");
        await stager.stage(rollbackMetadata, transaction, signal, ["app"]);
        await native.verifyInstaller(consumerInstallerPin(rollbackMetadata));
      }
    },
    verifyStage: async (metadata, transaction, signal) =>
      (await currentStager()).verifyStage(
        metadata,
        transaction,
        signal,
        await components(),
      ),
    preserveConsumers: preserve,
    backup: (metadata, _transaction, signal) => saveBackup(metadata, signal),
    restartRequired: options.onInstallerStarted,
    maintenance: async (transaction, signal) => {
      if (
        !options.consumerActivity ||
        typeof options.consumerActivity.acquire !== "function"
      )
        throw new Error("UPDATE_ACTIVITY_UNAVAILABLE");
      const activity = await options.consumerActivity.acquire(
        transaction,
        signal,
      );
      try {
        await activity.assertIdle(signal);
      } catch (error) {
        await activity.release();
        throw error;
      }
      heldActivity = activity;
      let lease: Awaited<ReturnType<typeof maintenance.acquire>>;
      try {
        const journal = (await store.read())?.journal;
        if (journal?.fleetForce) {
          await createSessionForcePort(session)
            .force(
              {
                ...journal.fleetForce,
                reason: "update",
                confirmation: transaction,
              },
              signal,
            )
            .catch((error) => {
              if (
                error instanceof Error &&
                error.message === "FORCE_CONFIRMATION_STALE"
              )
                throw new Error("UPDATE_FORCE_CONFIRMATION_STALE");
              throw error;
            });
        }
        lease = await maintenance.acquire(transaction, signal);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "SESSION_UNAVAILABLE"
        ) {
          await activity.release();
          throw error;
        }
        // Native singleton ownership plus durable idle confirmation provide
        // recovery when the prior session agent/UI exited during an app replace.
        const singleton = await native.acquireMutex("session");
        if (!singleton) {
          await activity.release();
          throw new Error("UPDATE_BUSY");
        }
        try {
          const stateStore = new VaultSessionStateStore(native),
            state = await stateStore.read(),
            update = await store.read();
          const recoverable =
            !!update?.journal &&
            update.journal.transaction === transaction &&
            [
              "staged",
              "fenced",
              "activating",
              "restart-required",
              "health-check",
              "rolling-back",
              "blocked",
            ].includes(update.journal.phase);
          const cold = !state && (await capturedPrevious()).runtime === null;
          const retired = !!state && !state.owner && !state.maintenance;
          if (
            (state && state.sid !== host.identity.sid) ||
            (!cold &&
              !retired &&
              (!state?.maintenance?.idle ||
                state.maintenance.transaction !== transaction)) ||
            !recoverable
          )
            throw new Error("UPDATE_RECOVERY_REQUIRED");
          if (state?.owner) {
            const process = await native.processIdentity(
              state.owner.identity.pid,
            );
            if (process && sameConsumerProcess(process, state.owner.identity))
              throw new Error("UPDATE_BUSY");
          }
          let closed = false;
          const finish = async () => {
            if (closed) return;
            if (state)
              await stateStore.write({
                ...state,
                owner: null,
                maintenance: null,
                revision: state.revision + 1,
              });
            closed = true;
            await native.releaseMutex(singleton);
          };
          lease = { release: finish, commit: finish };
        } catch (failure) {
          await native.releaseMutex(singleton);
          await activity.release();
          throw failure;
        }
      }
      let retired = false;
      const authority = session.currentAuthority();
      retireSession = async () => {
        if (retired) return;
        await activity.assertIdle(AbortSignal.timeout(30000));
        // The SID-wide activation mutex must be free before publishing a new bootstrap.
        try {
          await lease.commit();
          if (authority && !(await native.waitProcessExit(authority)))
            throw new Error("UPDATE_SESSION_STOP_UNCONFIRMED");
        } catch {
          throw new Error("UPDATE_SESSION_STOP_UNCONFIRMED");
        }
        retired = true;
      };
      return {
        release: async () => {
          if (retired) await options.onSessionRetired();
          else await lease.release();
          await activity.release();
          heldActivity = null;
          retireSession = null;
        },
        commit: async () => {
          await retireSession!();
          await options.onSessionRetired();
          await activity.commit();
          heldActivity = null;
          retireSession = null;
        },
      };
    },
    activate: async (metadata, transaction, signal) => {
      await preserve(signal);
      if (!heldActivity) throw new Error("UPDATE_ACTIVITY_UNAVAILABLE");
      await heldActivity.assertIdle(signal);
      if (!retireSession) throw new Error("UPDATE_MAINTENANCE_REQUIRED");
      await retireSession();
      if (compareWorkerReleaseVersions(app.version, metadata.app.version) < 0) {
        await launched(metadata);
        return "restart-required";
      }
      if (
        app.version !== metadata.app.version ||
        app.sha256 !== metadata.app.payloadSha256
      )
        throw new Error("UPDATE_INCOMPATIBLE");
      if ((await journalSource()) !== "catalog")
        await installer.assertCompleted(metadata);
      // Explicit app-only scope preserves absent readiness and never invokes inference/Prepare.
      if (await appOnly()) return;
      if (
        metadata.model.artifact.sha256 !== MODEL.sha256 ||
        metadata.model.artifact.bytes !== MODEL.bytes
      )
        throw new Error("UPDATE_INCOMPATIBLE");
      const preparation = operations(metadata),
        target = await preparation.target(signal);
      // Use the signed, already verified staged model; preserve its predecessor before replacement.
      await modelArchive.activate(
        consumerUpdateIdentity(metadata),
        {
          bytes: metadata.model.artifact.bytes,
          sha256: metadata.model.artifact.sha256,
        },
        signal,
      );
      for (const stage of PREPARE_STAGES)
        await preparation.perform(stage, target, signal, () => {});
      if (!(await preparation.verifyReady(target, signal)))
        throw new Error("UPDATE_HEALTH_FAILED");
      await preparation.registerBrowser(target, signal);
      const snapshot = await preparation.snapshotReady(signal);
      if (!heldPrepare) throw new Error("UPDATE_MAINTENANCE_REQUIRED");
      await refreshFleetAfterConsumerUpdate(
        {
          host,
          operations: preparation,
          prepareLease: heldPrepare,
          transaction,
          updateIdentity: consumerUpdateIdentity(metadata),
        },
        signal,
      );
      await activateDesktopSession(host, resourcesRoot, snapshot);
      const receipt = await ready(host),
        active: ActiveConsumerUpdate = {
          version: 1,
          kind: "consumer",
          signed: latest ?? (await store.read())?.journal?.signed,
          target: receipt.target,
          activatedAt: receipt.activatedAt,
          recoveryOf: null,
          ...((await journalSource()) === "catalog"
            ? {
                source: "catalog" as const,
                sourceDescriptor: consumerUpdateSourceDescriptor(
                  await sourceTrust("catalog"),
                ),
              }
            : {}),
        };
      await host.native.vaultWrite(
        "account",
        "consumer_update_active",
        Buffer.from(JSON.stringify(active)),
      );
      await host.prepareJournal.write({
        version: 1,
        transaction,
        target: receipt.target,
        sid: host.identity.sid,
        state: "complete",
        completed: [...PREPARE_STAGES],
      });
    },
    health: async (metadata, signal) => {
      try {
        if (
          app.version !== metadata.app.version ||
          app.sha256 !== metadata.app.payloadSha256
        )
          return false;
        if ((await journalSource()) !== "catalog")
          await installer.assertCompleted(metadata);
        if (await appOnly()) {
          const previous = await capturedPrevious(),
            installed = await current();
          return (
            JSON.stringify(installed.runtime) ===
              JSON.stringify(previous.runtime) &&
            JSON.stringify(installed.model) === JSON.stringify(previous.model)
          );
        }
        const prep = operations(metadata),
          target = await prep.target(signal),
          snapshot = await prep.snapshotReady(signal);
        if (
          snapshot.release !== target.identity ||
          snapshot.archiveSha256 !== metadata.runtime.artifact.sha256 ||
          snapshot.modelSha256 !== metadata.model.artifact.sha256 ||
          !snapshot.evidence.gpuIdentity
        )
          return false;
        resolveQualifiedGpuIdentity(
          snapshot.evidence.gpuIdentity,
          await host.native.enumerateGpus(),
        );
        const fleet = await new VaultFleetStore(
          host.native,
          host.identity.sid,
        ).read();
        if (fleet?.phase === "complete") {
          await readActiveFleetIdentity(host.native, fleet, {
            release: snapshot.release,
            manifestDigest: snapshot.manifestSha256,
            archiveDigest: snapshot.archiveSha256,
            modelDigest: snapshot.modelSha256,
          });
        }
        return await verifyBrowserIntegration(host, resourcesRoot);
      } catch {
        return false;
      }
    },
    rollback: async (previous, _transaction, signal) => {
      const metadata = await metadataFromJournal(),
        identity = consumerUpdateIdentity(metadata),
        bytes = await host.native.vaultRead(
          "account",
          backupKey(identity, "index"),
        );
      if (!bytes) throw new Error("UPDATE_ROLLBACK_UNAVAILABLE");
      let index: Backup;
      try {
        index = JSON.parse(bytes.toString("utf8")) as Backup;
        if (
          index.version !== 2 ||
          Object.keys(index).sort().join() !==
            "configuration,fields,fleetAuthority,identity,model,previous,version" ||
          typeof index.configuration !== "boolean" ||
          !index.fields ||
          Object.keys(index.fields).sort().join() !==
            Object.keys(FIELDS).sort().join() ||
          Object.values(index.fields).some(
            (value) => typeof value !== "boolean",
          ) ||
          (index.fleetAuthority !== null &&
            (typeof index.fleetAuthority !== "string" ||
              !/^[a-f0-9]{64}$/u.test(index.fleetAuthority))) ||
          index.identity !== identity ||
          JSON.stringify(index.previous) !== JSON.stringify(previous)
        )
          throw new Error("UPDATE_STATE_INVALID");
      } finally {
        bytes.fill(0);
      }
      if ((index.model?.sha256 ?? null) !== (previous.model?.sha256 ?? null))
        throw new Error("UPDATE_STATE_INVALID");
      if (index.model) {
        parseUpdateModelBlob(index.model);
        await modelArchive.restore(identity, index.model, signal);
      }
      const restoredFingerprint = index.model
        ? await privateFingerprint(host, `models\\${MODEL.filename}`)
        : null;
      const fleetLock = await host.native.acquireMutex("cache");
      if (!fleetLock) throw new Error("UPDATE_BUSY");
      try {
        const currentFleet = await new VaultFleetStore(
          host.native,
          host.identity.sid,
        ).read();
        if (
          (currentFleet ? fleetRecordAuthority(currentFleet) : null) !==
          index.fleetAuthority
        )
          throw new Error("UPDATE_FLEET_CHANGED");
        for (const [field, key] of Object.entries(FIELDS)) {
          if (field === "sequence") continue;
          const namespace = fieldNamespace(field);
          if (index.fields[field as keyof typeof FIELDS]) {
            const value = await host.native.vaultRead(
              "account",
              backupKey(identity, field),
            );
            if (!value) throw new Error("UPDATE_ROLLBACK_UNAVAILABLE");
            try {
              if (field === "active") {
                const record = JSON.parse(
                  value.toString("utf8"),
                ) as ActiveConsumerUpdate;
                record.recoveryOf = identity;
                await host.native.vaultWrite(
                  namespace,
                  key,
                  Buffer.from(JSON.stringify(record)),
                );
              } else if (field === "ready") {
                const receipt = JSON.parse(
                  value.toString("utf8"),
                ) as ReadyReceipt;
                if (
                  !index.model ||
                  !restoredFingerprint ||
                  receipt.modelSha256 !== index.model.sha256 ||
                  receipt.modelFingerprint.bytes !== index.model.bytes
                )
                  throw new Error("UPDATE_STATE_INVALID");
                receipt.modelFingerprint = restoredFingerprint;
                await host.native.vaultWrite(
                  namespace,
                  key,
                  Buffer.from(JSON.stringify(receipt)),
                );
              } else await host.native.vaultWrite(namespace, key, value);
            } finally {
              value.fill(0);
            }
          } else await host.native.vaultDelete(namespace, key);
        }
      } finally {
        await host.native.releaseMutex(fleetLock);
      }
      if (index.configuration) {
        const config = await host.native.vaultRead(
          "account",
          backupKey(identity, "config"),
        );
        if (!config) throw new Error("UPDATE_ROLLBACK_UNAVAILABLE");
        try {
          await writePrivateAtomic(host, "consumer-config.json", config);
        } finally {
          config.fill(0);
        }
      }
      if (app.version !== previous.app.version) {
        const old = await host.native.vaultRead(
          "account",
          "consumer_update_rollback_app",
        );
        if (!old) throw new Error("UPDATE_ROLLBACK_UNAVAILABLE");
        try {
          const row = JSON.parse(old.toString("utf8")) as {
              signed: { metadata: { publishedAt: string } };
            },
            approved = verifyConsumerUpdate(
              row.signed,
              trust,
              0,
              new Date(Date.parse(row.signed.metadata.publishedAt) + 1000),
            );
          if (
            approved.app.version !== previous.app.version ||
            approved.app.payloadSha256 !== previous.app.sha256
          )
            throw new Error("UPDATE_ROLLBACK_UNAVAILABLE");
          await launched(approved);
          return "restart-required";
        } finally {
          old.fill(0);
        }
      }
      signal.throwIfAborted();
      await registerBrowserIntegration(host, resourcesRoot);
    },
    verifyPrevious: async (previous, signal) => {
      try {
        const actual = await current();
        if (JSON.stringify(actual) !== JSON.stringify(previous)) return false;
        await installer.assertCurrentApp(previous.app);
        if (await appOnly()) return true;
        if (previous.runtime === null)
          return previous.model === null && (await optionalReady()) === null;
        if (!previous.model) return false;
        const proof = await optionalReady();
        if (!proof) return false;
        const bundle = await loadActiveConsumerPreparationBundle(
          host,
          resourcesRoot,
          0,
          proof,
        );
        if (!bundle) return false;
        const prep = new WindowsPreparationOperations(
          host,
          resourcesRoot,
          () => registerBrowserIntegration(host, resourcesRoot),
          async () => bundle,
        );
        if (!heldPrepare) throw new Error("UPDATE_MAINTENANCE_REQUIRED");
        await prep.requalifyInstalled(signal);
        const target = await prep.target(signal),
          snapshot = await prep.snapshotReady(signal);
        if (
          snapshot.release !== target.identity ||
          snapshot.archiveSha256 !== previous.runtime.sha256 ||
          snapshot.modelSha256 !== previous.model.sha256 ||
          !snapshot.evidence.gpuIdentity
        )
          return false;
        resolveQualifiedGpuIdentity(
          snapshot.evidence.gpuIdentity,
          await host.native.enumerateGpus(),
        );
        const fleet = await new VaultFleetStore(
          host.native,
          host.identity.sid,
        ).read();
        if (fleet?.phase === "complete") {
          const journal = (await store.read())?.journal;
          if (!journal) return false;
          await refreshFleetAfterConsumerUpdate(
            {
              host,
              operations: prep,
              prepareLease: heldPrepare,
              transaction: journal.transaction,
              updateIdentity: journal.identity,
            },
            signal,
          );
          await readActiveFleetIdentity(host.native, fleet, {
            release: snapshot.release,
            manifestDigest: snapshot.manifestSha256,
            archiveDigest: snapshot.archiveSha256,
            modelDigest: snapshot.modelSha256,
          });
        }
        if (!(await verifyBrowserIntegration(host, resourcesRoot)))
          return false;
        await prep.recaptureStartupReceipt(signal);
        return true;
      } catch {
        return false;
      }
    },
    cleanup: async (retain, signal) => {
      const backups = await retention(),
        kept = backups.slice(0, 2),
        receipt = await optionalReady(),
        protectedReleases = new Set<string>(receipt ? [receipt.release] : []);
      for (const id of kept) {
        const bytes = await host.native.vaultRead(
          "account",
          backupKey(id, "ready"),
        );
        if (bytes) {
          try {
            const row = JSON.parse(bytes.toString("utf8")) as {
              release: string;
            };
            if (!/^[a-f0-9]{64}$/u.test(row.release))
              throw new Error("UPDATE_STATE_INVALID");
            protectedReleases.add(row.release);
          } finally {
            bytes.fill(0);
          }
        }
      }
      for (const id of backups.slice(2)) {
        await modelArchive.remove(id);
        for (const field of [...Object.keys(FIELDS), "config", "index"])
          await host.native.vaultDelete("account", backupKey(id, field));
      }
      await backupRetention.write(kept);
      await stager.cleanup(
        [
          ...retain,
          ...kept,
          ...(rollbackMetadata
            ? [consumerUpdateIdentity(rollbackMetadata)]
            : []),
        ],
        signal,
      );
      if (!receipt) return;
      const releases = await host.directory("runtime\\releases"),
        names = await readdir(releases);
      if (names.length > 32) throw new Error("UPDATE_CLEANUP_PENDING");
      for (const id of names) {
        signal.throwIfAborted();
        if (!/^[a-f0-9]{64}$/u.test(id) || protectedReleases.has(id)) continue;
        const bytes = await host.native.vaultRead(
          "account",
          `runtime_${id.slice(0, 56)}`,
        );
        if (!bytes) continue;
        try {
          const proof = JSON.parse(bytes.toString("utf8")) as {
            release: string;
            manifestSha256: string;
            sid: string;
          };
          if (
            proof.release !== id ||
            proof.sid !== host.identity.sid ||
            !/^[a-f0-9]{64}$/u.test(proof.manifestSha256)
          )
            throw new Error("UPDATE_STATE_INVALID");
          await host.native.validatePath(
            "personal",
            `runtime\\releases\\${id}`,
            "directory",
          );
          await verifyWindowsRelease(win32.join(releases, id), "windows-user");
          if (!(await native.removeUnusedRelease(id, proof.manifestSha256)))
            continue;
          await host.native.vaultDelete(
            "account",
            `runtime_${id.slice(0, 56)}`,
          );
        } finally {
          bytes.fill(0);
        }
      }
    },
  });
}
