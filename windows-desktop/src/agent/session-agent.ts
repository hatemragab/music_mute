import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConsumerNativeEvent } from "../../../worker/src/platform/windows/consumer-native.js";
import { createPersonalSessionPort } from "../main/personal/session-port.js";
import { createQualifiedSessionGpuAdmission } from "../main/admission/session-admission.js";
import { openSessionRuntimeContext } from "../main/session/bootstrap.js";
import {
  createSessionDispatcher,
  serveSessionControl,
} from "../main/session/control.js";
import type { SessionRuntimeContext } from "../main/session/context.js";
import { StoreRuntimeContext } from "../main/session/store-runtime-context.js";
import { VaultSessionStateStore } from "../main/session/state-store.js";
import { VaultFleetStore, fleetRecordAuthority } from "../main/fleet/store.js";
import { openStoreFleetSessionPort } from "../main/fleet/store-session-port.js";
import {
  SessionSupervisor,
  type FleetSessionPort,
} from "../main/session/supervisor.js";

/** Independent login-session authority. Imports never start a worker or enroll a machine. */
export async function runSessionAgent(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  delete process.env.MUSICMUTE_OWNERSHIP_NONCE;
  delete process.env.MUSICMUTE_OWNERSHIP_ROLE;
  const storeMode = argv.length === 1 && argv[0] === "--store-session";
  if (
    !storeMode &&
    (argv.length !== 2 || argv[0] !== "--consumer-config" || !argv[1])
  )
    throw new Error("SESSION_CONTEXT_INVALID");
  const context = storeMode
    ? await StoreRuntimeContext.open()
    : await openSessionRuntimeContext(argv[1]!);
  const lifetime = new AbortController();
  const cleanup: (() => void)[] = [];
  let supervisor: SessionSupervisor | undefined,
    gpu:
      | Awaited<ReturnType<typeof createQualifiedSessionGpuAdmission>>
      | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    lifetime.abort();
    stopping ??= (async () => {
      try {
        await supervisor?.logout();
      } finally {
        try {
          await gpu?.close();
        } finally {
          await context.close();
        }
      }
    })();
    void stopping.catch(() => {
      process.exitCode = 1;
    });
  };
  const event = (value: ConsumerNativeEvent) => {
    if (!supervisor) return;
    if (value.kind === "child_exit") {
      if (value.owner.role === "personal" || value.owner.role === "fleet")
        void supervisor
          .childExited(value.owner)
          .then(() => gpu?.broker.recover())
          .catch(stop);
    } else if (value.kind === "session" && value.event === "ending") stop();
    else if (
      value.kind === "session" &&
      value.event !== "ending_requested" &&
      value.event !== "ending"
    )
      void supervisor
        .sessionEvent(value.event)
        .then(() => gpu?.broker.recover())
        .catch(stop);
  };
  const hooked = new Set<string>();
  const native = context.sessionNative;
  const guardedNative = {
    ...native,
    launchOwned: async (role: "personal" | "fleet", release: string) => {
      const guardian = await context.guardian(role);
      if (!hooked.has(role)) {
        hooked.add(role);
        cleanup.push(guardian.onEvent(event), guardian.onClosed(stop));
      }
      return native.launchOwned(role, release);
    },
  };
  cleanup.push(context.native.onEvent(event), context.native.onClosed(stop));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const personal = await createPersonalSessionPort(
      context,
      context.configuration.backendOrigin
        ? { backendOrigin: context.configuration.backendOrigin }
        : {},
    );
    // Store context and its private classes must stay inside this source graph.
    // The independent legacy bundle has its own legacy factory boundary.
    let fleet: FleetSessionPort;
    if (context instanceof StoreRuntimeContext) {
      fleet = openStoreFleetSessionPort(context);
    } else {
      const fleetModule = (await import(
        pathToFileURL(
          win32.join(context.configuration.releaseRoot, "agent", "fleet.cjs"),
        ).href
      )) as {
        createFleetSessionPort?: (
          context: SessionRuntimeContext,
        ) => FleetSessionPort;
        default?: {
          createFleetSessionPort?: (
            context: SessionRuntimeContext,
          ) => FleetSessionPort;
        };
      };
      const factory =
        fleetModule.createFleetSessionPort ??
        fleetModule.default?.createFleetSessionPort;
      if (typeof factory !== "function")
        throw new Error("SESSION_INTEGRITY_INVALID");
      fleet = factory(context);
    }
    const identity = await context.native.identity();
    const fleetStore = new VaultFleetStore(context.native, identity.sid);
    supervisor = new SessionSupervisor({
      release: context.configuration.release,
      native: guardedNative,
      state: new VaultSessionStateStore(context.native),
      fleet,
      personal,
      forceAuthority: {
        verifyPeer: (peer) =>
          context instanceof StoreRuntimeContext
            ? StoreRuntimeContext.prototype.verifyGuiPeer.call(context, peer)
            : context.native.verifyPersonalOwnerProofPeers(
                peer,
                peer,
                "desktop",
              ),
        identity: async () => {
          const record = await fleetStore.read();
          return record?.phase === "complete" &&
            record.machineId &&
            record.machineCredential
            ? {
                machineId: record.machineId,
                authority: fleetRecordAuthority(record),
              }
            : null;
        },
      },
      maintenanceReady: async () => {
        if (!gpu) return false;
        await gpu.broker.recover();
        const view = gpu.broker.snapshot();
        return view.state === "idle" && view.waiting === 0;
      },
    });
    // Admission must exist before intent restoration can start a role runtime.
    gpu = await createQualifiedSessionGpuAdmission(context, {
      personal: personal.client,
      currentOwner: (role) => supervisor!.roleOwner(role),
    });
    const dispatcher = createSessionDispatcher(
      supervisor,
      personal.client,
      gpu,
      context.native,
      stop,
      (owner, peer) => context.verifyOwnedPeer(owner, peer),
    );
    const serving =
      context instanceof StoreRuntimeContext
        ? context.storeIssuer.serveControl(dispatcher, lifetime.signal)
        : serveSessionControl(context, dispatcher, lifetime.signal);
    void serving.catch(stop);
    await supervisor.start();
    await context.completeStartup();
    await serving;
  } finally {
    stop();
    await stopping;
    for (const remove of cleanup) remove();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
if (typeof require !== "undefined" && require.main === module) {
  runSessionAgent().catch(() => {
    process.exitCode = 1;
  });
}
