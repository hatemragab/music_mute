import { randomUUID } from "node:crypto";
import type { SessionClient } from "./control.js";
/** This fence is durable across UI/controller crashes. Busy drain is never forced. */
export function createSessionMaintenancePort(
  client: Pick<SessionClient, "command">,
) {
  return {
    acquire: async (transaction: string, signal: AbortSignal) => {
      const snapshot = await client.command(
        {
          version: 1,
          request_id: randomUUID(),
          action: "maintenance_begin",
          transaction,
        },
        signal,
      );
      if (
        snapshot.maintenance?.transaction !== transaction ||
        snapshot.maintenance.phase !== "idle"
      )
        throw new Error("UPDATE_BUSY");
      return {
        commit: async () => {
          await client.command({
            version: 1,
            request_id: randomUUID(),
            action: "maintenance_commit",
            transaction,
          });
        },
        release: async () => {
          await client.command({
            version: 1,
            request_id: randomUUID(),
            action: "maintenance_end",
            transaction,
          });
        },
      };
    },
    cancel: async (transaction: string, signal: AbortSignal) => {
      await client.command(
        {
          version: 1,
          request_id: randomUUID(),
          action: "maintenance_end",
          transaction,
        },
        signal,
      );
    },
  };
}
