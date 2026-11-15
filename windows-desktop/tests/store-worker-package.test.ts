import { describe, expect, it, vi } from "vitest";
import {
  evaluateObservedStoreWorker,
  parseStoreWorkerPackageObservation,
} from "../src/main/browser/store-worker-package.js";
import {
  parseStoreInstalledPackage,
  STORE_PRODUCTS,
} from "../src/shared/store-contracts.js";

function installed(role: "gui" | "worker", version?: string) {
  const product = STORE_PRODUCTS[role];
  const packageVersion = version ?? product.packageVersion;
  const fullName = `${product.identityName}_${packageVersion}_x64__${product.publisherId}`;
  return {
    identityName: product.identityName,
    publisher: product.publisher,
    publisherId: product.publisherId,
    familyName: product.familyName,
    fullName,
    packageVersion,
    architecture: "x64",
    signatureKind: 3,
    healthy: true,
    current: true,
    installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
  };
}
describe("Store Worker installation receiving boundary", () => {
  it("separates actual absence from compatible installation without creating processing authority", () => {
    const gui = parseStoreInstalledPackage("gui", installed("gui"));
    expect(
      evaluateObservedStoreWorker(
        gui,
        parseStoreWorkerPackageObservation({ version: 1, state: "missing" }),
      ),
    ).toMatchObject({ ready: false, reason: "WORKER_MISSING" });
    const observation = parseStoreWorkerPackageObservation({
      version: 1,
      state: "installed",
      package: installed("worker", "0.1.3.7"),
    });
    expect(Object.isFrozen(observation)).toBe(true);
    expect(evaluateObservedStoreWorker(gui, observation)).toMatchObject({
      ready: true,
      protocolAbi: 1,
    });
    expect(Object.hasOwn(observation, "qualification")).toBe(false);
  });
  it("keeps an installed incompatible version visible for explicit recovery", () => {
    const observation = parseStoreWorkerPackageObservation({
      version: 1,
      state: "installed",
      package: installed("worker", "0.2.0.0"),
    });
    expect(
      evaluateObservedStoreWorker(
        parseStoreInstalledPackage("gui", installed("gui")),
        observation,
      ),
    ).toMatchObject({ ready: false, reason: "PAIR_INCOMPATIBLE" });
  });
  it.each([
    null,
    [],
    { version: 1, state: "error" },
    { version: 1, state: "missing", package: null },
    { version: 1, state: "missing", allowUnsigned: true },
    { version: 1, state: "installed" },
    { version: 2, state: "missing" },
    { version: 1, state: "installed", package: installed("gui") },
    {
      version: 1,
      state: "installed",
      package: { ...installed("worker"), signatureKind: 0 },
    },
    {
      version: 1,
      state: "installed",
      package: { ...installed("worker"), current: false },
    },
    {
      version: 1,
      state: "installed",
      package: { ...installed("worker"), healthy: false },
    },
  ])("rejects unproved or mixed observation %#", (value) => {
    expect(() => parseStoreWorkerPackageObservation(value)).toThrow(
      "STORE_WORKER_OBSERVATION_INVALID",
    );
  });
  it("rejects accessors, inherited state and symbol fields without evaluating getters", () => {
    const getter = vi.fn(() => "missing");
    const value = { version: 1 };
    Object.defineProperty(value, "state", { enumerable: true, get: getter });
    expect(() => parseStoreWorkerPackageObservation(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      parseStoreWorkerPackageObservation(
        Object.assign(Object.create({ state: "missing" }), { version: 1 }),
      ),
    ).toThrow();
    expect(() =>
      parseStoreWorkerPackageObservation({
        version: 1,
        state: "missing",
        [Symbol("authority")]: true,
      }),
    ).toThrow();
  });
});
