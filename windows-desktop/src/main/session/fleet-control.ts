import { randomUUID } from "node:crypto";
import type {
  FleetControlPort,
  FleetControlState,
} from "../fleet/controller.js";
import type { SessionClient } from "./control.js";
import type { SessionSnapshot } from "../../shared/session-contracts.js";

/** Saved intent comes only from the detached session authority. */
export function createSessionFleetControlPort(
  client: Pick<SessionClient, "command">,
): FleetControlPort {
  const state = (snapshot: SessionSnapshot): FleetControlState => ({
    intent: snapshot.fleet.intent,
    revision: snapshot.revision,
  });
  return {
    read: async () =>
      state(
        await client.command({
          version: 1,
          request_id: randomUUID(),
          action: "status",
        }),
      ),
    intent: async (intent, requestId, signal) => {
      signal.throwIfAborted();
      return state(
        await client.command(
          { version: 1, request_id: requestId, action: "fleet_intent", intent },
          signal,
        ),
      );
    },
    restart: async (requestId, signal) => {
      signal.throwIfAborted();
      return state(
        await client.command(
          { version: 1, request_id: requestId, action: "fleet_restart" },
          signal,
        ),
      );
    },
  };
}
