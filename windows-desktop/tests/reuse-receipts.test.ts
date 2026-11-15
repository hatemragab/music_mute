import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import {
  createReuseReceipt,
  parseReuseReceipt,
  parseCompletionReceipt,
} from "../src/main/reuse/receipts.js";
import { parsePersonalPair } from "../src/main/reuse/pair.js";
import { outboxInstallation } from "./outbox-fixtures.js";
import { receiptFixture } from "./reuse-fixtures.js";
describe("private reuse/completion receipts", () => {
  it("binds actual acquired input, fixed model/recipe and both immutable pair hashes", () => {
    const f = receiptFixture();
    expect(f.pair.reuse?.source.kind).toBe("youtube");
    expect(f.pair.completion?.capturedAccountScope).toEqual(f.capture);
    for (const change of [
      { modelDigest: "e".repeat(64) },
      { recipeDigest: "e".repeat(64) },
      { trimEnabled: true },
      { vocalsSha256: "f".repeat(64) },
      { source: { ...f.reuse.source, inputBytes: 0 } },
    ])
      expect(() =>
        parseReuseReceipt(
          { ...f.reuse, ...change },
          {
            originalSha256: f.entry.original.sha256,
            vocalsSha256: f.entry.vocals.sha256,
          },
        ),
      ).toThrow();
  });
  it("never fabricates reuse proof when engine recipe digest or source proof is missing/wrong", () => {
    expect(
      createReuseReceipt(
        {
          modelDigest: MODEL.sha256,
          recipeRevision: 6,
          recipeId: "kim-vocals-v2",
          trimEnabled: false,
          denoiseEnabled: false,
        },
        { bytes: 1, sha256: "a".repeat(64) },
        "b".repeat(64),
        "c".repeat(64),
      ),
    ).toBeUndefined();
    const f = receiptFixture();
    expect(() =>
      parsePersonalPair(
        { ...f.raw, jobId: randomUUID() },
        outboxInstallation,
        f.entry.personalJobId,
      ),
    ).toThrow();
  });
  it("accepts old playable pair without auto-save/reuse eligibility, and permanently preserves null capture", () => {
    const f = receiptFixture(),
      {
        reuseReceipt: _reuse,
        completionReceipt: _completion,
        ...legacy
      } = f.raw;
    expect(
      parsePersonalPair(legacy, outboxInstallation, f.entry.personalJobId)
        .reuse,
    ).toBeUndefined();
    expect(
      parseCompletionReceipt(
        { ...f.completion, capturedAccountScope: null },
        {
          installationId: outboxInstallation,
          jobId: f.entry.personalJobId,
          originalSha256: f.entry.original.sha256,
          vocalsSha256: f.entry.vocals.sha256,
        },
      ).capturedAccountScope,
    ).toBeNull();
    expect(() =>
      parseCompletionReceipt(
        { ...f.completion, installationId: randomUUID() },
        {
          installationId: outboxInstallation,
          jobId: f.entry.personalJobId,
          originalSha256: f.entry.original.sha256,
          vocalsSha256: f.entry.vocals.sha256,
        },
      ),
    ).toThrow();
  });
});
