import { describe, expect, it, vi } from "vitest";
import { saveLocalToAccount } from "../src/main/outbox/local-save.js";
import { emptyPartition } from "../src/main/library/store.js";
import { localTrackId } from "../src/main/library/model.js";
import { receiptFixture } from "./reuse-fixtures.js";
function fixture() {
  const f = receiptFixture(),
    scope = { ...f.capture },
    guest = emptyPartition(null),
    stage = vi.fn(async () => ({}) as never);
  guest.entries.push(f.pair.entry);
  let current = scope;
  const options = {
    trackId: localTrackId(f.pair.entry),
    scope,
    assertScope: (candidate: typeof scope) => {
      if (
        candidate.firebaseUid !== current.firebaseUid ||
        candidate.generation !== current.generation
      )
        throw new Error("ACCOUNT_CHANGED");
    },
    store: {
      snapshot: vi.fn(async () => ({
        guest,
        account: emptyPartition(scope.firebaseUid),
      })),
    },
    pair: vi.fn(async () => f.pair),
    outbox: { stage },
  };
  return {
    f,
    scope,
    options,
    stage,
    change: () => {
      current = { ...scope, firebaseUid: "B" };
    },
  };
}
describe("explicit local Save to account authority", () => {
  it("captures the current account even for an originally guest result", async () => {
    const h = fixture();
    h.f.pair.completion!.capturedAccountScope = null;
    await saveLocalToAccount(h.options);
    expect(h.stage).toHaveBeenCalledWith(h.f.pair.entry, h.scope, "pair");
  });
  it("uses community-link instead of duplicate private upload for verified community media", async () => {
    const h = fixture();
    h.f.pair.reuse!.source = {
      kind: "community-youtube",
      videoId: "bZxrIoCPsOc",
      provenance: "trusted",
      sourceIdentityVerified: true,
      inputBytes: 1000,
      inputSha256: h.f.pair.entry.original.sha256,
    };
    await saveLocalToAccount(h.options);
    expect(h.stage).toHaveBeenCalledWith(
      h.f.pair.entry,
      h.scope,
      "community-link",
    );
  });
  it("never reassigns an operation after an account switch during pair read", async () => {
    const h = fixture();
    h.options.pair = vi.fn(async () => {
      h.change();
      return h.f.pair;
    });
    await expect(saveLocalToAccount(h.options)).rejects.toThrow(
      "ACCOUNT_CHANGED",
    );
    expect(h.stage).not.toHaveBeenCalled();
  });
  it("refuses incompatible or mismatched local pairs before durable staging", async () => {
    const h = fixture();
    delete h.f.pair.reuse;
    await expect(saveLocalToAccount(h.options)).rejects.toThrow(
      "OUTBOX_PROFILE_UNSUPPORTED",
    );
    expect(h.stage).not.toHaveBeenCalled();
  });
  it("cannot select an account track or an unknown local ID", async () => {
    const h = fixture();
    h.options.trackId = "account:123";
    await expect(saveLocalToAccount(h.options)).rejects.toThrow(
      "LIBRARY_ACTION_UNAVAILABLE",
    );
    expect(h.options.pair).not.toHaveBeenCalled();
  });
});
