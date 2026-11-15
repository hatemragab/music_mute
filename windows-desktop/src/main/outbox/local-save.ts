import type { AccountSessionScope } from "../account/account-controller.js";
import type { LibraryStore } from "../library/store.js";
import { localTrackId, type LocalLibraryEntry } from "../library/model.js";
import type { VerifiedPersonalPair } from "../reuse/pair.js";
import type { OutboxController } from "./controller.js";

/** Explicit guest saving captures authority here, never from a renderer supplied UID. */
export async function saveLocalToAccount(options: {
  trackId: string;
  scope: AccountSessionScope;
  assertScope(scope: AccountSessionScope): void;
  store: Pick<LibraryStore, "snapshot">;
  pair(entry: LocalLibraryEntry): Promise<VerifiedPersonalPair>;
  outbox: Pick<OutboxController, "stage">;
}): Promise<void> {
  const scope = { ...options.scope };
  options.assertScope(scope);
  const snapshot = await options.store.snapshot(scope);
  options.assertScope(scope);
  const entry = snapshot.guest.entries.find(
    (row) => localTrackId(row) === options.trackId,
  );
  if (!entry) throw new Error("LIBRARY_ACTION_UNAVAILABLE");
  const pair = await options.pair(entry);
  options.assertScope(scope);
  if (
    !pair.reuse ||
    pair.entry.personalJobId !== entry.personalJobId ||
    pair.entry.vocals.sha256 !== entry.vocals.sha256 ||
    pair.entry.original.sha256 !== entry.original.sha256
  )
    throw new Error("OUTBOX_PROFILE_UNSUPPORTED");
  await options.outbox.stage(
    pair.entry,
    scope,
    pair.reuse.source.kind === "community-youtube" ? "community-link" : "pair",
  );
  options.assertScope(scope);
}
