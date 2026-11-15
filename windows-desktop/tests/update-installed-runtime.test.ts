import { expect, it } from "vitest";
import { receipt, sid } from "./fixtures/prepare.js";
import { parseInstalledReadyMetadata } from "../src/main/update/installed-runtime.js";
import { parseReadyReceipt } from "../src/main/prepare/operations.js";
it("retains legacy/stale installed metadata without manufacturing operational Ready or absent bytes", () => {
  const current = receipt(),
    { bootIdentity: _boot, ...rest } = current,
    legacy = { ...rest, version: 1 },
    stale = { ...current, bootIdentity: "f".repeat(64) };
  const legacyMetadata = parseInstalledReadyMetadata(legacy, sid),
    staleMetadata = parseInstalledReadyMetadata(stale, sid);
  expect(legacyMetadata).toEqual(staleMetadata);
  expect(Object.keys(legacyMetadata)).not.toContain("bootIdentity");
  expect(Object.keys(legacyMetadata)).not.toContain("qualification");
  expect(legacyMetadata.release).toBe(current.release);
  expect(() =>
    parseReadyReceipt(
      legacy,
      { sid, identity: current.target },
      current.bootIdentity,
    ),
  ).toThrow("INTEGRITY_INVALID");
  expect(() =>
    parseReadyReceipt(
      stale,
      { sid, identity: current.target },
      current.bootIdentity,
    ),
  ).toThrow("INTEGRITY_INVALID");
});
it("refuses malformed metadata, unknown fields, foreign owner and accessor coercion", () => {
  const current = receipt(),
    getter = { ...current };
  Object.defineProperty(getter, "version", {
    get() {
      throw new Error("must not execute accessor");
    },
    enumerable: true,
  });
  for (const bad of [
    getter,
    { ...current, version: 3 },
    { ...current, sid: "foreign" },
    { ...current, target: "C:\\runtime" },
    { ...current, modelSha256: "0".repeat(64) },
    { ...current, path: "secret" },
    { ...current, modelFingerprint: { ...current.modelFingerprint, bytes: 0 } },
  ])
    expect(() => parseInstalledReadyMetadata(bad, sid)).toThrow(
      "UPDATE_STATE_INVALID",
    );
});
