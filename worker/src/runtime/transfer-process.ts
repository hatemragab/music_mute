/** Private one-operation helper. Grants arrive over IPC, never argv or environment. */
import { randomUUID } from "node:crypto";
import { open, link, unlink } from "node:fs/promises";
import { join } from "node:path";

import type {
  WorkerTransferClient,
  TransferClientOptions,
} from "./transfers.js";
import type {
  ObjectIdentity,
  TransferGrant,
  UploadGrant,
} from "./contracts.js";

export interface TransferProcessRequest {
  operation: "download" | "upload";
  workspace: string;
  path: string;
  grant: TransferGrant | UploadGrant;
  expected:
    | ObjectIdentity
    | { bytes: number; sha256: string; contentType: "audio/mpeg" };
  options: Omit<TransferClientOptions, "fetch">;
}

process.on("disconnect", () => process.exit(2));
process.once("message", async (message: TransferProcessRequest) => {
  let reply: object;
  try {
    const ownerUrl = new URL(
      import.meta.url.endsWith(".ts")
        ? "./transfer-workspace-owner.ts"
        : "./transfer-workspace-owner.js",
      import.meta.url,
    );
    const { assertNoLiveTransfer } = (await import(
      ownerUrl.href
    )) as typeof import("./transfer-workspace-owner.js");
    await assertNoLiveTransfer(message.workspace, true);
    const temporary = join(
      message.workspace,
      `transfer-owner.${randomUUID()}.tmp`,
    );
    const marker = await open(temporary, "wx", 0o600);
    try {
      await marker.writeFile(
        JSON.stringify({ schemaVersion: 1, pid: process.pid }),
      );
      await marker.sync();
    } finally {
      await marker.close();
    }
    await link(temporary, join(message.workspace, "transfer-owner.json"));
    await unlink(temporary);
    if (process.platform !== "win32") {
      const directory = await open(message.workspace, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    const moduleUrl = new URL(
      import.meta.url.endsWith(".ts") ? "./transfers.ts" : "./transfers.js",
      import.meta.url,
    );
    const module = (await import(
      moduleUrl.href
    )) as typeof import("./transfers.js");
    const client: WorkerTransferClient = new module.WorkerTransferClient(
      message.options,
    );
    const result =
      message.operation === "download"
        ? await client.download(
            message.grant,
            message.expected as ObjectIdentity,
            message.path,
          )
        : await client.upload(
            message.grant as UploadGrant,
            message.path,
            message.expected as {
              bytes: number;
              sha256: string;
              contentType: "audio/mpeg";
            },
          );
    reply = { ok: true, result: result ?? null };
  } catch (error) {
    // Preserve safe retry classification without raw URLs, paths, or error messages.
    const transfer = error as {
      code?: unknown;
      retryable?: unknown;
      diagnostic?: unknown;
    };
    reply = {
      ok: false,
      retryable:
        typeof transfer?.retryable === "boolean" ? transfer.retryable : true,
      diagnostic:
        typeof transfer?.diagnostic === "string" &&
        /^[a-z0-9-]{1,80}$/u.test(transfer.diagnostic)
          ? transfer.diagnostic
          : "transfer-process-failed",
    };
  }
  process.send?.(reply, () => process.exit(0));
});
