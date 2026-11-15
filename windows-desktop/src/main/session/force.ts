import type { SessionClient } from "./control.js";
import type { SessionSnapshot } from "../../shared/session-contracts.js";

/** Only an already reviewed protected Advanced transaction may reach this port.
 * The server independently authenticates the sole signed Main authority, exact
 * machine/approval, current snapshot revision and one-use confirmation UUID. */
export function createSessionForcePort(client: Pick<SessionClient, "command">) {
  return {
    force: async (
      request: {
        reason: "stop" | "restart" | "update" | "revoke";
        machineId: string;
        authority: string;
        expectedRevision: number;
        confirmation: string;
      },
      signal: AbortSignal,
    ): Promise<SessionSnapshot> =>
      client.command(
        {
          version: 1,
          action: "fleet_force",
          request_id: request.confirmation,
          confirmation: request.confirmation,
          reason: request.reason,
          machine_id: request.machineId,
          authority: request.authority,
          expected_revision: request.expectedRevision,
        },
        signal,
      ),
  };
}
