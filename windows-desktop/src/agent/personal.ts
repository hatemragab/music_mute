import { PACKAGE_DATA_ROOT_NAMES } from "../shared/package-build-profile.js";
import { StoreNodeIssuer } from "../main/session/store-node-issuer.js";
import {
  StorePersonalRuntime,
  type StorePersonalRunConfiguration,
} from "../main/personal/store-runtime.js";
import { parseSessionSnapshot } from "../shared/session-snapshot.js";
import { parsePersonalCommand } from "../shared/personal-contracts.js";
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { win32 } from "node:path";
import {
  createConsumerNativeTransport,
  WindowsConsumerNative,
  sameConsumerProcess,
} from "../../../worker/src/platform/windows/consumer-native.js";
import { verifyWindowsRelease } from "../../../worker/src/platform/windows/release-manifest.js";
import { HostContext } from "../main/host-context.js";
import {
  parsePersonalAgentConfiguration,
  type PersonalAgentConfiguration,
} from "../main/personal/configuration.js";
import {
  PersonalProcessingController,
  PersonalFailure,
} from "../main/personal/controller.js";
import { createPersonalActivityNotifier } from "../main/personal/activity-notifier.js";
import { SessionClient } from "../main/session/control.js";
import { DirectmlPersonalRunner } from "../main/personal/runner.js";
import { PrivatePersonalStorage } from "../main/personal/storage.js";
import { BrokerPersonalAdmission } from "../main/personal/broker-admission.js";
import { createRoleGpuGateway } from "../main/admission/session-admission.js";
import { createPersonalRequestJournal } from "../main/personal/journal.js";
import { LibraryStore, WindowsLibraryDisk } from "../main/library/store.js";
import { LibraryPins } from "../main/library/pins.js";
import { LibraryArtifactCache } from "../main/library/artifacts.js";
import { WindowsPersonalReuse } from "../main/personal/reuse.js";
import { personalMediaTools } from "../main/personal/media-tools.js";
import {
  LocalStartupMeasurements,
  windowsStartupMeasurementStore,
} from "../main/prepare/startup-measurements.js";
import { WindowsStorageController } from "../main/storage/controller.js";
import { WindowsOutboxStore } from "../main/outbox/store.js";
import {
  durableLibraryRetainedDirectories,
  durablePendingOriginalBytes,
} from "../main/library/retained-directories.js";
import { WindowsPublicationStore } from "../main/reuse/publication.js";
import {
  PersonalCommandRouter,
  servePersonalAgent,
} from "../main/personal/server.js";
/** Fixed standard-user role. Importing this module never starts a process or pipe. */
export async function runPersonalAgent(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (argv.length === 1 && argv[0] === "--store-session")
    return runStorePersonalAgent();
  const nonce = process.env.MUSICMUTE_OWNERSHIP_NONCE,
    role = process.env.MUSICMUTE_OWNERSHIP_ROLE;
  delete process.env.MUSICMUTE_OWNERSHIP_NONCE;
  delete process.env.MUSICMUTE_OWNERSHIP_ROLE;
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    role !== "personal" ||
    !nonce ||
    !/^[a-f0-9]{64}$/.test(nonce) ||
    argv.length !== 2 ||
    argv[0] !== "--consumer-config" ||
    !argv[1]
  )
    throw new Error("PERSONAL_CONTEXT_INVALID");
  const root = win32.resolve(process.cwd()),
    configPath = win32.join(root, "personal-config.json");
  if (win32.resolve(argv[1]).toLowerCase() !== configPath.toLowerCase())
    throw new Error("PERSONAL_CONFIG_INVALID");
  const info = await lstat(configPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > 16384
  )
    throw new Error("PERSONAL_CONFIG_INVALID");
  const { configuration } = parsePersonalAgentConfiguration(
    JSON.parse(await readFile(configPath, "utf8")),
  );
  if (
    configuration.personalRoot.toLowerCase() !== root.toLowerCase() ||
    win32.resolve(process.execPath).toLowerCase() !==
      win32
        .join(configuration.releaseRoot, "runtime", "node", "node.exe")
        .toLowerCase() ||
    win32.resolve(process.argv[1] ?? "").toLowerCase() !==
      win32
        .join(configuration.releaseRoot, "agent", "personal.cjs")
        .toLowerCase()
  )
    throw new Error("PERSONAL_CONTEXT_INVALID");
  const manifest = await verifyWindowsRelease(
    configuration.releaseRoot,
    "windows-user",
  );
  const digest = createHash("sha256")
    .update(
      await readFile(
        win32.join(configuration.releaseRoot, "release-manifest.json"),
      ),
    )
    .digest("hex");
  const helper = manifest.entries.find(
    (entry) =>
      entry.kind === "file" &&
      entry.path === "runtime/native/musicmute-native.exe",
  );
  if (
    digest !== configuration.manifestSha256 ||
    helper?.kind !== "file" ||
    helper.sha256 !== configuration.nativeSha256
  )
    throw new Error("PERSONAL_INTEGRITY_INVALID");
  const helperPath = win32.join(
    configuration.releaseRoot,
    "runtime",
    "native",
    "musicmute-native.exe",
  );
  const native = new WindowsConsumerNative(
      await createConsumerNativeTransport(
        helperPath,
        configuration.nativeSha256,
      ),
    ),
    server = new WindowsConsumerNative(
      await createConsumerNativeTransport(
        helperPath,
        configuration.nativeSha256,
      ),
    ),
    admissionServer = new WindowsConsumerNative(
      await createConsumerNativeTransport(
        helperPath,
        configuration.nativeSha256,
      ),
    ),
    eventsServer = new WindowsConsumerNative(
      await createConsumerNativeTransport(
        helperPath,
        configuration.nativeSha256,
      ),
    );
  return runPersonalCore({
    configuration,
    root,
    nonce,
    helperPath,
    native,
    server,
    admissionServer,
    eventsServer,
  });
}
interface PersonalActor {
  configuration: PersonalAgentConfiguration | StorePersonalRunConfiguration;
  root: string;
  nonce: string;
  helperPath: string;
  native: WindowsConsumerNative;
  server?: WindowsConsumerNative;
  admissionServer?: WindowsConsumerNative;
  eventsServer?: WindowsConsumerNative;
  host?: HostContext;
  issuer?: StoreNodeIssuer;
  runtime?: StorePersonalRuntime;
}
async function runPersonalCore(actor: PersonalActor): Promise<void> {
  const {
    configuration,
    root,
    nonce,
    helperPath,
    native,
    server,
    admissionServer,
    eventsServer,
    issuer,
    runtime,
  } = actor;
  if (issuer) {
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    if (
      !runtime ||
      !actor.host ||
      issuer.nodeRole !== "personal" ||
      configuration !== runtime.configuration
    )
      throw new Error("PERSONAL_CONTEXT_INVALID");
    StorePersonalRuntime.prototype.assertConfiguration.call(
      runtime,
      actor.host,
      runtime.configuration,
    );
  }
  const lifetime = new AbortController();
  let controller: PersonalProcessingController | undefined;
  let reuse: WindowsPersonalReuse | undefined;
  let stopPending: Promise<void> | undefined;
  let notifier: ReturnType<typeof createPersonalActivityNotifier> | undefined;
  const stop = () => {
    lifetime.abort();
    stopPending ??= controller?.stop() ?? Promise.resolve();
    void stopPending.catch(() => {
      process.exitCode = 1;
    });
  };
  const closed = native.onClosed(stop),
    serverClosed = server?.onClosed(stop),
    admissionClosed = admissionServer?.onClosed(stop),
    eventsClosed = eventsServer?.onClosed(stop);
  let servers: Promise<void>[] = [];
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const host =
        actor.host ?? (await HostContext.initialize(native, "0.1.0", 1)),
      ownerIdentity = await native.processIdentity(process.pid);
    if (
      !ownerIdentity ||
      host.identity.sid !== configuration.sid ||
      host.personalRoot.toLowerCase() !== root.toLowerCase()
    )
      throw new Error("PERSONAL_CONTEXT_INVALID");
    if (
      issuer &&
      (issuer.owner.nonce !== nonce ||
        !sameConsumerProcess(issuer.owner.identity, ownerIdentity))
    )
      throw new Error("PERSONAL_CONTEXT_INVALID");
    if (!issuer)
      await native.validatePath("personal", "personal-config.json", "file");
    if (!issuer)
      await native.bindOwnedRole({
        role: "personal",
        nonce,
        identity: ownerIdentity,
      });
    const admission = new BrokerPersonalAdmission(
      native,
      createRoleGpuGateway({
        releaseRoot: configuration.releaseRoot,
        personalRoot: root,
        fleetRoot: win32.join(
          host.identity.localAppData,
          PACKAGE_DATA_ROOT_NAMES.fleet,
        ),
        role: "personal",
        ownershipNonce: nonce,
        ...(issuer
          ? { distribution: "microsoft-store" as const, storeIssuer: issuer }
          : {}),
        native,
        ownerIdentity,
        openNative: async () =>
          issuer
            ? issuer.openNative()
            : new WindowsConsumerNative(
                await createConsumerNativeTransport(
                  helperPath,
                  configuration.nativeSha256,
                ),
              ),
      }),
    );
    const runner = new DirectmlPersonalRunner({
      host,
      configuration,
      ...(runtime ? { storeRuntime: runtime } : {}),
      hardware: () => native.enumerateGpus(),
      admission,
      workspace: async (relative) => {
        await native.ensurePrivateDirectory("personal", relative);
        const workspace = await storage.trackWorkspace(
          relative,
          owner,
          "processing",
        );
        let cleaned = false;
        return {
          cleanup: async () => {
            if (cleaned) return;
            await workspace.releaseExitedSessionProtection();
            await storage.removeExitedSessionWorkspace(relative);
            cleaned = true;
          },
          release: () => workspace.release(),
        };
      },
      measurements: new LocalStartupMeasurements(
        windowsStartupMeasurementStore(host),
      ),
    });
    const library = new LibraryStore(new WindowsLibraryDisk(host), (scope) => {
      if (scope === null) return true;
      const current = controller?.currentScope() ?? null;
      return (
        current?.firebaseUid === scope?.firebaseUid &&
        current?.generation === scope?.generation
      );
    });
    const owner = { role: "personal" as const, nonce, identity: ownerIdentity },
      outboxStore = new WindowsOutboxStore(host),
      publicationStore = new WindowsPublicationStore(host);
    const pins = new LibraryPins(
      host,
      (pid) => native.processIdentity(pid),
      () => durableLibraryRetainedDirectories(outboxStore, publicationStore),
    );
    const storage = new WindowsStorageController({
      host,
      pins,
      processIdentity: (pid) => native.processIdentity(pid),
      treeExited: (receipt) => native.ownedTreeExited(receipt),
      pendingOriginalBytes: () => durablePendingOriginalBytes(outboxStore),
    });
    const cache = new LibraryArtifactCache(host, (value) => {
      const current = controller?.currentScope();
      return (
        current?.firebaseUid === value.firebaseUid &&
        current.generation === value.generation
      );
    });
    const admissionHooks = {
      reserveScratch: (bytes: number, relative: string) =>
        storage.reserveScratch(bytes, relative),
      beginWrite: (relative: string, kind: "file" | "tree") =>
        storage.beginWrite(relative, kind),
      protectTree: (relative: string, purpose: "processing" | "download") =>
        storage.protectTree(relative, purpose),
      reserveVoice: (bytes: number, relative: string) =>
        storage.reserveVoice(bytes, relative),
      trackWorkspace: (
        relative: string,
        receipt: import("../../../worker/src/platform/windows/consumer-native.js").ConsumerOwnedProcess,
        purpose: "processing" | "download",
      ) => storage.trackWorkspace(relative, receipt, purpose),
    };
    cache.setAdmissionHooks(admissionHooks);
    reuse = new WindowsPersonalReuse({
      host,
      store: library,
      cache,
      pins,
      admission: admissionHooks,
      tools: personalMediaTools(configuration, runtime),
      ...("backendOrigin" in configuration && configuration.backendOrigin
        ? { backendOrigin: configuration.backendOrigin }
        : {}),
    });
    controller = new PersonalProcessingController({
      storage: new PrivatePersonalStorage(host, {
        assertRecoveredExit: (relative) =>
          storage.assertWorkspaceExited(relative),
        beginWrite: (relative, kind) => storage.beginWrite(relative, kind),
        trackWorkspace: (relative) =>
          storage.trackWorkspace(relative, owner, "processing"),
        protectTree: (relative, purpose) =>
          storage.protectTree(relative, purpose),
        protectPlannedTree: (relative, purpose) =>
          storage.protectTree(relative, purpose, true),
        reserveVoice: (bytes, relative) =>
          storage.reserveVoice(bytes, relative),
      }),
      runner,
      journal: createPersonalRequestJournal(host),
      reuse,
      onResult: (view, _scope, result) =>
        library
          .rememberPersonal({ ...view, state: "ready" }, null, result?.timeline)
          .then(() => {}),
    });
    await controller.initialize();
    notifier = createPersonalActivityNotifier({
      owner,
      subscribe: (listener) => controller!.subscribe(listener),
      signal: lifetime.signal,
      open: async () => {
        if (issuer) {
          const helper = await issuer.openNative();
          return {
            notify: async (receipt: typeof owner, signal: AbortSignal) => {
              const requestId = randomUUID(),
                response = await issuer.requestControlWithNative(
                  helper,
                  "session",
                  Buffer.from(
                    JSON.stringify({
                      version: 1,
                      kind: "personal-activity",
                      request_id: requestId,
                      ownerReceipt: receipt,
                    }),
                  ),
                  signal,
                );
              const reply = parseStrictJson(
                new TextDecoder("utf8", { fatal: true }).decode(response),
                32768,
              ) as Record<string, unknown>;
              if (
                !reply ||
                Object.keys(reply).sort().join() !==
                  "ok,request_id,snapshot,version" ||
                reply.version !== 1 ||
                reply.request_id !== requestId ||
                reply.ok !== true
              )
                throw new Error("SESSION_UNAVAILABLE");
              return parseSessionSnapshot(reply.snapshot);
            },
            close: () => helper.close(),
          };
        }
        const helper = new WindowsConsumerNative(
            await createConsumerNativeTransport(
              helperPath,
              configuration.nativeSha256,
            ),
          ),
          client = new SessionClient(helper);
        return {
          notify: (receipt, signal) =>
            client.notifyPersonalActivity(receipt, signal),
          close: () => helper.close(),
        };
      },
    });
    const router = new PersonalCommandRouter(
      controller,
      configuration,
      admission,
      ...(issuer ? ([{ issuer, native }] as const) : []),
    );
    const retiringReplies = new Set<string>();
    servers = issuer
      ? [
          issuer.serveControl(
            {
              dispatch: async (payload, peer) => {
                try {
                  const result = await router.command(
                    Buffer.from(payload),
                    peer,
                  );
                  if (result.stop) retiringReplies.add(result.reply.requestId);
                  return Buffer.from(JSON.stringify(result.reply));
                } catch (error) {
                  const envelope = JSON.parse(
                      Buffer.from(payload).toString("utf8"),
                    ),
                    command = parsePersonalCommand(
                      Buffer.from(JSON.stringify(envelope.command)),
                    );
                  return Buffer.from(
                    JSON.stringify({
                      version: 1,
                      requestId: command.requestId,
                      ok: false,
                      error:
                        error instanceof PersonalFailure
                          ? error.code
                          : "INVALID_REQUEST",
                    }),
                  );
                }
              },
              afterReply: (payload) => {
                const envelope = JSON.parse(
                  Buffer.from(payload).toString("utf8"),
                );
                const command = parsePersonalCommand(
                  Buffer.from(JSON.stringify(envelope.command)),
                );
                if (retiringReplies.delete(command.requestId)) stop();
              },
            },
            lifetime.signal,
          ),
        ]
      : [
          servePersonalAgent(
            server!,
            owner,
            router,
            lifetime.signal,
            "personal_ticket",
          ),
          servePersonalAgent(
            admissionServer!,
            owner,
            router,
            lifetime.signal,
            "personal_admission_ticket",
          ),
          servePersonalAgent(
            eventsServer!,
            owner,
            router,
            lifetime.signal,
            "personal_events_ticket",
          ),
        ];
    await Promise.race(servers);
  } finally {
    stop();
    // Retain the physical guard on unconfirmed teardown. The session guardian
    // must terminate the whole owned role before recovery can release it.
    await stopPending;
    await notifier?.dispose();
    await reuse?.dispose();
    closed();
    serverClosed?.();
    admissionClosed?.();
    eventsClosed?.();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await server?.close();
    await admissionServer?.close();
    await eventsServer?.close();
    await Promise.allSettled(servers);
    await native.close();
  }
}
async function runStorePersonalAgent(): Promise<void> {
  const issuer = await StoreNodeIssuer.open();
  try {
    if (issuer.nodeRole !== "personal")
      throw new Error("PERSONAL_CONTEXT_INVALID");
    const native = await issuer.openNative(),
      host = await HostContext.initialize(native, "0.1.0", 1),
      runtime = await StorePersonalRuntime.open(host, issuer);
    await runPersonalCore({
      issuer,
      runtime,
      host,
      native,
      configuration: runtime.configuration,
      root: host.personalRoot,
      nonce: issuer.owner.nonce,
      helperPath: win32.join(
        issuer.workerRoot,
        "runtime",
        "native",
        "musicmute-native.exe",
      ),
    });
  } finally {
    await issuer.close();
  }
}
if (typeof require !== "undefined" && require.main === module) {
  runPersonalAgent().catch(() => {
    process.exitCode = 1;
  });
}
