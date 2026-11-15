import { win32 } from "node:path";
import type { OutboxStore } from "../outbox/store.js";
import { outboxRoot } from "../outbox/model.js";
import type { PublicationStore } from "../reuse/publication.js";

/** Admission validates every durable owner, including discarded copies whose
 * cleanup has not been confirmed. Inventory already counts the actual bytes. */
export async function durablePendingOriginalBytes(
  outbox: Pick<OutboxStore, "list">,
): Promise<number> {
  return (await outbox.list()).reduce(
    (sum, record) =>
      sum + (record.copiesReleased ? 0 : (record.original?.bytes ?? 0)),
    0,
  );
}

/** LibraryPins calls this under its SID cache mutex. Read all durable owners,
 * including when no account or publication controller is configured. A corrupt
 * or unreadable journal must refuse cleanup instead of implying no retention. */
export async function durableLibraryRetainedDirectories(
  outbox: Pick<OutboxStore, "list">,
  publications: Pick<PublicationStore, "list">,
): Promise<Set<string>> {
  const records = await outbox.list(),
    pending = await publications.list(),
    directories = new Set<string>();
  for (const record of records) {
    if (record.copiesReleased) continue;
    directories.add(outboxRoot(record));
    if (!record.captured)
      directories.add(win32.dirname(record.vocals.sourceRelativePath));
  }
  for (const record of pending)
    if (record.state === "pending")
      directories.add(`personal\\results\\${record.jobId}`);
  return directories;
}
