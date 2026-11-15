import type { HostContext } from "../host-context.js";
import {
  PERSONAL_UUID,
  parsePersonalScope,
} from "../../shared/personal-contracts.js";
import {
  PersonalFailure,
  type PersonalRequestJournal,
  type PersonalRequestReceipt,
} from "./controller.js";
export function createPersonalRequestJournal(
  host: HostContext,
): PersonalRequestJournal {
  return {
    read: async () => {
      const bytes = await host.native.vaultRead("account", "personal_requests");
      if (!bytes) return [];
      const row = JSON.parse(bytes.toString("utf8")) as {
        version: number;
        receipts: PersonalRequestReceipt[];
      };
      if (
        !row ||
        row.version !== 1 ||
        Object.keys(row).sort().join() !== "receipts,version" ||
        !Array.isArray(row.receipts) ||
        row.receipts.length > 32
      )
        throw new PersonalFailure("OUTPUT_INVALID");
      const seen = new Set<string>();
      for (const receipt of row.receipts) {
        if (
          !receipt ||
          ![
            "digest,jobId,ownerId,requestId,state",
            "capturedAccountScope,digest,jobId,ownerId,requestId,state",
          ].includes(Object.keys(receipt).sort().join()) ||
          [receipt.ownerId, receipt.requestId, receipt.jobId].some(
            (value) => typeof value !== "string" || !PERSONAL_UUID.test(value),
          ) ||
          typeof receipt.digest !== "string" ||
          !/^[a-f0-9]{64}$/.test(receipt.digest) ||
          !["inflight", "settled"].includes(receipt.state) ||
          seen.has(`${receipt.ownerId}:${receipt.requestId}`)
        )
          throw new PersonalFailure("OUTPUT_INVALID");
        seen.add(`${receipt.ownerId}:${receipt.requestId}`);
        if (receipt.capturedAccountScope !== undefined)
          receipt.capturedAccountScope = parsePersonalScope(
            receipt.capturedAccountScope,
          );
      }
      return row.receipts;
    },
    write: async (receipts) => {
      await host.native.vaultWrite(
        "account",
        "personal_requests",
        Buffer.from(JSON.stringify({ version: 1, receipts })),
      );
    },
  };
}
