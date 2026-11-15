import { localDiagnostics, withLocalLogContext } from "./local-debug.js";
import { randomUUID } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import {
  parseDesktopCommand,
  type DesktopCommand,
  type DesktopReply,
} from "../shared/contracts.js";
import { trustedSender } from "./security.js";

/** Shared production ingress: only the packaged top frame can invoke a closed command. */
export function createDesktopIpcHandler(
  execute: (
    command: DesktopCommand,
    senderCurrent: () => boolean,
  ) => Promise<DesktopReply>,
  isCurrentSender: (sender: IpcMainInvokeEvent["sender"]) => boolean,
) {
  return async (
    event: Pick<IpcMainInvokeEvent, "senderFrame" | "sender">,
    input: unknown,
  ): Promise<DesktopReply> => {
    const sender = event.sender,
      frame = event.senderFrame;
    const senderCurrent = (): boolean => {
      try {
        return (
          isCurrentSender(sender) &&
          trustedSender(frame?.url, frame === sender.mainFrame)
        );
      } catch {
        return false;
      }
    };
    if (!senderCurrent()) return { ok: false, errorCode: "UNAUTHORIZED" };
    let command: DesktopCommand;
    try {
      command = parseDesktopCommand(input);
    } catch {
      return { ok: false, errorCode: "INVALID_REQUEST" };
    }
    try {
      return await withLocalLogContext(
        { operationId: randomUUID() },
        async () => {
          localDiagnostics.emit("ipc.command", command, "debug", {
            phase: "main_accepted",
          });
          const reply = await execute(command, senderCurrent);
          localDiagnostics.emit(
            "ipc.result",
            reply,
            reply.ok ? "info" : "warn",
            {
              phase: "main_completed",
              result: reply.ok ? "success" : "failure",
            },
          );
          return reply;
        },
      );
    } catch {
      return { ok: false, errorCode: "OPERATION_FAILED" };
    }
  };
}
