import { createHash, randomUUID } from "node:crypto";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import type {
  ConsumerAccountAppPin,
  ConsumerProcessIdentity,
  WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import { parseBrowserAccountTicket } from "./account-bridge.js";
import { loadBrowserAccountAppPin, openBrowserNative } from "./native.js";
import type { HostContext } from "../host-context.js";
import {
  acquireDesktopAccountAuthorityGate,
  openPinnedBrowserNative,
} from "./native.js";
import { openWindowsHost } from "../host-context.js";
import { registerBrowserIntegration } from "./registration.js";
import { openDesktopSessionClient } from "../session/desktop-client.js";
import { createSessionMaintenancePort } from "../session/maintenance.js";
import { loadPackagedDesktopBuild } from "./package-trust.js";

export interface InstallerMaintenanceCommand {
  version: 1;
  request_id: string;
  action: "install" | "uninstall" | "register";
}
/** Concrete early installed-app mode. It never restores account tokens or starts
 * a missing session agent and keeps ordinary uninstall data/identity intact. */
export async function runInstallerLifecycle(
  resourcesRoot: string,
  action: "install" | "uninstall" | "register",
): Promise<void> {
  if (!["install", "uninstall", "register"].includes(action))
    throw new Error("PEER_DENIED");
  const native = await openPinnedBrowserNative(resourcesRoot);
  let gated:
    Awaited<ReturnType<typeof acquireDesktopAccountAuthorityGate>> | undefined;
  let host: HostContext | undefined;
  let connected:
    Awaited<ReturnType<typeof openDesktopSessionClient>> | undefined;
  try {
    const identity = await native.identity(),
      pin = await loadBrowserAccountAppPin(resourcesRoot);
    const proof = await native.verifyInstallerMaintenancePeer(
      identity,
      action === "uninstall" ? "uninstall" : "install",
      pin,
    );
    gated = await acquireDesktopAccountAuthorityGate(native);
    if (gated.state === "same-session-existing") {
      await requestInstallerMaintenance({ identity }, resourcesRoot, action);
      return;
    }
    const session = await native.inspectSingletonOwner("session");
    if (session.state === "active" && !session.sameSession)
      throw new Error("WINDOWS_SESSION_ALREADY_ACTIVE");
    const build = await loadPackagedDesktopBuild(resourcesRoot);
    host = await openWindowsHost(
      resourcesRoot,
      build.appVersion,
      build.buildNumber,
    );
    if (action !== "register" && session.state === "active") {
      connected = await openDesktopSessionClient(host, resourcesRoot, {
        launchIfAbsent: false,
      });
      const transaction = createHash("sha256")
          .update(
            JSON.stringify([
              "installer-standalone-v1",
              proof.issuer,
              proof.certificateNonce,
              action,
              randomUUID(),
            ]),
          )
          .digest("hex"),
        maintenance = createSessionMaintenancePort(connected.client);
      let lease;
      try {
        lease = await maintenance.acquire(
          transaction,
          AbortSignal.timeout(30000),
        );
      } catch (error) {
        await maintenance
          .cancel(transaction, AbortSignal.timeout(30000))
          .catch(() => {});
        throw error;
      }
      await lease.commit();
      if (!(await native.waitProcessExit(session.owner, 30000)))
        throw new Error("INSTALLER_BUSY");
    }
    if (action === "uninstall") {
      await native.unregisterBrowser();
      // The signed worker shim/capsule and its Run value live outside the GUI
      // package. Ordinary app removal preserves separately approved worker intent.
      await native.unregisterProtocol();
    } else if (action === "register") {
      await registerBrowserIntegration(host, resourcesRoot);
      await native.registerProtocol();
    }
  } finally {
    await Promise.allSettled([connected?.close(), host?.close()]);
    if (gated?.state === "acquired") await gated.close();
    else await native.close().catch(() => {});
  }
}
export type InstallerMaintenanceReply =
  | {
      version: 1;
      request_id: string;
      ok: true;
      transaction: string;
      action: "install" | "uninstall" | "register";
    }
  | {
      version: 1;
      request_id: string;
      ok: false;
      error_code: "INSTALLER_BUSY" | "PEER_DENIED" | "INSTALLER_UNAVAILABLE";
    };
export interface InstallerMaintenanceReservation {
  assertIdle(): void | Promise<void>;
  commit(): Promise<void>;
  release(): Promise<void>;
}
export interface InstallerMaintenanceContext {
  action: "install" | "uninstall";
  issuer: ConsumerProcessIdentity;
  certificateNonce: string | null;
}
export interface InstallerMaintenanceHandler {
  execute(
    value: unknown,
    peer: ConsumerProcessIdentity,
    signal: AbortSignal,
  ): Promise<InstallerMaintenanceReply>;
  acknowledged(reply: InstallerMaintenanceReply): Promise<void>;
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.sort().join()
  )
    throw new Error("PEER_DENIED");
  return value as Record<string, unknown>;
}
export function parseInstallerMaintenanceCommand(
  value: unknown,
): InstallerMaintenanceCommand {
  const row = exact(value, ["version", "request_id", "action"]);
  if (
    row.version !== 1 ||
    typeof row.request_id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      row.request_id,
    ) ||
    (row.action !== "install" &&
      row.action !== "uninstall" &&
      row.action !== "register")
  )
    throw new Error("PEER_DENIED");
  return row as unknown as InstallerMaintenanceCommand;
}
/** This private route is absent from Chrome's public protocol. Actual signed
 * installer lineage is checked independently of command-line strings. */
export function createInstallerMaintenanceHandler(options: {
  native: Pick<WindowsConsumerNative, "verifyInstallerMaintenancePeer">;
  pin: ConsumerAccountAppPin;
  reserve(
    transaction: string,
    signal: AbortSignal,
    context: InstallerMaintenanceContext,
  ): Promise<InstallerMaintenanceReservation>;
  unregisterOwned(): Promise<void>;
  registerOwned(): Promise<void>;
  retire(): Promise<void>;
}): InstallerMaintenanceHandler {
  let current:
    | {
        request: InstallerMaintenanceCommand;
        issuer: ConsumerProcessIdentity;
        transaction: string;
        reservation: InstallerMaintenanceReservation;
        reply: InstallerMaintenanceReply;
      }
    | undefined;
  let busy = false;
  let committed = false;
  let committing: Promise<void> | undefined;
  return {
    async execute(value, peer, signal) {
      const command = parseInstallerMaintenanceCommand(value);
      let reservation: InstallerMaintenanceReservation | undefined;
      let admitted = false;
      try {
        const receipt = await options.native.verifyInstallerMaintenancePeer(
          peer,
          command.action === "register" ? "install" : command.action,
          options.pin,
        );
        signal.throwIfAborted();
        if (command.action === "register") {
          if (busy || committed || current) throw new Error("INSTALLER_BUSY");
          busy = true;
          admitted = true;
          await options.registerOwned();
          signal.throwIfAborted();
          return {
            version: 1,
            request_id: command.request_id,
            ok: true,
            transaction: createHash("sha256")
              .update(JSON.stringify([receipt, command]))
              .digest("hex"),
            action: "register",
          };
        }
        if (current) {
          if (
            JSON.stringify(current.issuer) === JSON.stringify(receipt.issuer) &&
            JSON.stringify(current.request) === JSON.stringify(command)
          )
            return current.reply;
          throw new Error("INSTALLER_BUSY");
        }
        if (busy || committed) throw new Error("INSTALLER_BUSY");
        busy = true;
        admitted = true;
        const transaction = createHash("sha256")
          .update(
            JSON.stringify([
              "installer-maintenance-v1",
              receipt.issuer,
              receipt.certificateNonce,
              command,
            ]),
          )
          .digest("hex");
        reservation = await options.reserve(transaction, signal, {
          action: command.action,
          issuer: receipt.issuer,
          certificateNonce: receipt.certificateNonce,
        });
        signal.throwIfAborted();
        await reservation.assertIdle();
        if (command.action === "uninstall") await options.unregisterOwned();
        await reservation.assertIdle();
        signal.throwIfAborted();
        const reply: InstallerMaintenanceReply = {
          version: 1,
          request_id: command.request_id,
          ok: true,
          transaction,
          action: command.action,
        };
        current = {
          request: command,
          issuer: receipt.issuer,
          transaction,
          reservation,
          reply,
        };
        return reply;
      } catch (error) {
        await reservation?.release().catch(() => {});
        const message = error instanceof Error ? error.message : "";
        return {
          version: 1,
          request_id: command.request_id,
          ok: false,
          error_code:
            message === "PEER_DENIED"
              ? "PEER_DENIED"
              : [
                    "INSTALLER_BUSY",
                    "UPDATE_BUSY",
                    "ACCOUNT_AUTHORITY_BUSY",
                    "CHILD_SHUTDOWN_PENDING",
                  ].includes(message)
                ? "INSTALLER_BUSY"
                : "INSTALLER_UNAVAILABLE",
        };
      } finally {
        if (admitted) busy = false;
      }
    },
    async acknowledged(reply) {
      if (!reply.ok || committed || reply.action === "register") return;
      if (!current || JSON.stringify(current.reply) !== JSON.stringify(reply))
        throw new Error("PEER_DENIED");
      committing ??= (async () => {
        await current.reservation.assertIdle();
        await current.reservation.commit();
        committed = true;
        // The transport invokes this only after its native ACK. Root then drains
        // the sole authority and releases the SID gate after account cleanup.
        await options.retire();
      })();
      await committing;
    },
  };
}
/** Fixed installed-app client; Root calls this before singleton/UI initialization.
 * No automatic mutation retry after an uncertain response. */
export async function requestInstallerMaintenance(
  host: Pick<HostContext, "identity">,
  resourcesRoot: string,
  action: "install" | "uninstall" | "register",
): Promise<void> {
  if (action !== "install" && action !== "uninstall" && action !== "register")
    throw new Error("PEER_DENIED");
  const native = await openBrowserNative(host, resourcesRoot);
  try {
    const pin = await loadBrowserAccountAppPin(resourcesRoot),
      peer = await native.identity();
    await native.verifyInstallerMaintenancePeer(
      peer,
      action === "register" ? "install" : action,
      pin,
    );
    const accountOwner = await native.inspectSingletonOwner("account");
    if (accountOwner.state !== "active" || !accountOwner.sameSession)
      throw new Error("INSTALLER_BUSY");
    const bytes = await native.vaultRead("account", "browser_ticket");
    if (!bytes) throw new Error("INSTALLER_UNAVAILABLE");
    let ticket;
    try {
      ticket = parseBrowserAccountTicket(
        parseStrictJson(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ),
      );
    } finally {
      bytes.fill(0);
    }
    if (
      ticket.owner.sid !== peer.sid ||
      ticket.owner.sessionId !== peer.sessionId
    )
      throw new Error("PEER_DENIED");
    if (
      !(await native.verifyAccountPeer(ticket.owner, "authority", pin)) ||
      !(await native.claimBrowserAccountTicket(ticket.nonce))
    )
      throw new Error("INSTALLER_BUSY");
    const command: InstallerMaintenanceCommand = {
      version: 1,
      request_id: randomUUID(),
      action,
    };
    const response = await native.pipeConnect({
      channel: ticket.channel,
      nonce: ticket.nonce,
      peer: ticket.server,
      payload: Buffer.from(
        JSON.stringify({ version: 1, kind: "installer-maintenance", command }),
      ),
      timeoutMs: 30000,
    });
    const parsed = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(response),
      4096,
    ) as { ok?: unknown };
    const reply = exact(parsed, [
      "version",
      "request_id",
      "ok",
      ...(parsed.ok === true ? ["transaction", "action"] : ["error_code"]),
    ]);
    if (reply.version !== 1 || reply.request_id !== command.request_id)
      throw new Error("PEER_DENIED");
    if (reply.ok !== true)
      throw new Error(
        reply.error_code === "INSTALLER_BUSY"
          ? "INSTALLER_BUSY"
          : "INSTALLER_UNAVAILABLE",
      );
    if (
      reply.action !== action ||
      typeof reply.transaction !== "string" ||
      !/^[a-f0-9]{64}$/u.test(reply.transaction)
    )
      throw new Error("PEER_DENIED");
    if (
      action !== "register" &&
      !(await native.waitProcessExit(accountOwner.owner, 30000))
    )
      throw new Error("INSTALLER_BUSY");
  } finally {
    await native.close();
  }
}
