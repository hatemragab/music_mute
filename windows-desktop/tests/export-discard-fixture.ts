import { lstat, unlink } from "node:fs/promises";
import type { CreatedExportDiscardPort } from "../src/main/save-destinations.js";

/** Synthetic single-threaded Node filesystem receiver only. This supports
 * portable caller/certificate tests; it does not prove Win32 handle deletion. */
export function fixtureCreatedExportDiscard(): CreatedExportDiscardPort {
  const completed = new Map<string, string>();
  return async (request) => {
    const identity = JSON.stringify(request);
    const prior = completed.get(request.requestId);
    const result = () => ({
      state: "completed" as const,
      acknowledge: async () => {
        completed.delete(request.requestId);
      },
    });
    if (prior) {
      if (prior !== identity) throw new Error("FIXTURE_DISCARD_CHANGED");
      return result();
    }
    const actual = await lstat(request.path, { bigint: true });
    if (
      !actual.isFile() ||
      actual.isSymbolicLink() ||
      actual.nlink !== 1n ||
      actual.dev.toString() !== request.birth.device ||
      actual.ino.toString() !== request.birth.fileId ||
      actual.birthtimeNs.toString() !== request.birth.bornAt ||
      actual.size !== BigInt(request.bytes) ||
      actual.mtimeNs.toString() !== request.writtenAt ||
      actual.ctimeNs.toString() !== request.changedAt
    )
      throw new Error("FIXTURE_DISCARD_CHANGED");
    await unlink(request.path);
    completed.set(request.requestId, identity);
    return result();
  };
}
