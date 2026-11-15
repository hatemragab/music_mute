import { randomUUID } from "node:crypto";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { FULL_TIMELINE_RECIPE_DIGEST } from "../../chrome-extension/src/companion/cloud-provider.js";
import { createReuseReceipt } from "../src/main/reuse/receipts.js";
import { parsePersonalPair } from "../src/main/reuse/pair.js";
import type { CompletionReceipt } from "../src/shared/reuse-contracts.js";
import { localEntry, outboxInstallation } from "./outbox-fixtures.js";
export function receiptFixture() {
  const entry = localEntry(true),
    capture = { firebaseUid: "A", generation: randomUUID() },
    ownerId = randomUUID();
  const reuse = createReuseReceipt(
    {
      recipeId: "kim-vocals-v2",
      recipeRevision: 6,
      recipeDigest: FULL_TIMELINE_RECIPE_DIGEST,
      modelDigest: MODEL.sha256,
      trimEnabled: false,
      denoiseEnabled: false,
    },
    {
      bytes: 1000,
      sha256: "d".repeat(64),
      sourceIdentity: {
        kind: "youtube",
        videoId: "bZxrIoCPsOc",
        formatId: "140",
        audioTrackId: null,
        audioIsDefault: true,
        language: "en",
        inputBytes: 1000,
        inputSha256: "d".repeat(64),
      },
    },
    entry.original.sha256,
    entry.vocals.sha256,
  )!;
  const completion: CompletionReceipt = {
    version: 1 as const,
    installationId: outboxInstallation,
    jobId: entry.personalJobId,
    ownerId,
    requestId: randomUUID(),
    capturedAccountScope: capture,
    originalSha256: entry.original.sha256,
    vocalsSha256: entry.vocals.sha256,
    completedAt: Date.now(),
  };
  const raw = {
    version: 1,
    jobId: entry.personalJobId,
    original: { ...entry.original, filename: "original.m4a" },
    vocals: { ...entry.vocals, filename: "vocals.mp3" },
    reuseReceipt: reuse,
    completionReceipt: completion,
  };
  return {
    entry,
    capture,
    reuse,
    completion,
    raw,
    pair: parsePersonalPair(raw, outboxInstallation, entry.personalJobId),
  };
}
