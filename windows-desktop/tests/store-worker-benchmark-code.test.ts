import { expect, it, vi } from "vitest";
import { parseStoreWorkerBenchmarkObservation } from "../src/main/browser/store-worker-code.js";
import {
  StoreNativeAuthority,
  StoreWorkerCodeAuthority,
} from "../src/main/browser/store-native.js";

const observation = () => ({
  inventorySha256: "a".repeat(64),
  runtimeManifestSha256: "b".repeat(64),
  helperSha256: "c".repeat(64),
  engineDigest: "d".repeat(64),
});
it("returns closed immutable digest observations without a code or benchmark capability", () => {
  const input = observation(),
    result = parseStoreWorkerBenchmarkObservation(input);
  input.engineDigest = "e".repeat(64);
  expect(result.engineDigest).toBe("d".repeat(64));
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.keys(result)).toHaveLength(4);
  expect(result).not.toHaveProperty("launch");
});
it.each(Object.keys(observation()))(
  "rejects missing, changed-type or noncanonical %s",
  (key) => {
    for (const value of [
      undefined,
      null,
      true,
      1,
      "A".repeat(64),
      "a".repeat(63),
    ]) {
      const input = { ...observation(), [key]: value };
      if (value === undefined) Reflect.deleteProperty(input, key);
      expect(() => parseStoreWorkerBenchmarkObservation(input)).toThrow(
        "STORE_WORKER_CODE_DENIED",
      );
    }
  },
);
it("rejects caller resource fields, custom prototypes and accessors without invoking the getter", () => {
  for (const key of ["path", "argv", "ready", "binding", "allow_unsigned"])
    expect(() =>
      parseStoreWorkerBenchmarkObservation({ ...observation(), [key]: true }),
    ).toThrow();
  expect(() =>
    parseStoreWorkerBenchmarkObservation(
      Object.assign(Object.create({ path: "caller" }), observation()),
    ),
  ).toThrow();
  const getter = vi.fn(() => "d".repeat(64)),
    input = observation();
  Object.defineProperty(input, "engineDigest", {
    enumerable: true,
    get: getter,
  });
  expect(() => parseStoreWorkerBenchmarkObservation(input)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("cannot create a living benchmark code owner from public observations or forged private prototypes", async () => {
  const read = vi.fn(),
    authority = Object.assign(Object.create(StoreNativeAuthority.prototype), {
      workerBenchmarkCodeView: read,
    }),
    owner = Object.assign(Object.create(StoreWorkerCodeAuthority.prototype), {
      benchmarkCodeView: read,
    });
  await expect(
    StoreWorkerCodeAuthority.prototype.benchmarkCodeView.call(owner),
  ).rejects.toThrow();
  await expect(
    StoreNativeAuthority.prototype.workerBenchmarkCodeView.call(
      authority,
      owner,
    ),
  ).rejects.toThrow();
  expect(() =>
    Reflect.construct(StoreWorkerCodeAuthority, [
      Symbol("caller"),
      authority,
      observation(),
    ]),
  ).toThrow();
  expect(read).not.toHaveBeenCalled();
});
