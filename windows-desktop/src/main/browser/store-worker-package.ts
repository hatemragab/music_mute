import {
  evaluateStorePackagePair,
  parseStoreInstalledPackage,
  type StoreInstalledPackage,
  type StorePairEvaluation,
} from "../../shared/store-contracts.js";

/** Installation observation only. Even a compatible pair still requires the
 * Worker creator/role capability and current GPU/model qualification. */
export type StoreWorkerPackageObservation =
  | { readonly version: 1; readonly state: "missing" }
  | {
      readonly version: 1;
      readonly state: "installed";
      readonly package: StoreInstalledPackage;
    };

function denied(): never {
  throw new Error("STORE_WORKER_OBSERVATION_INVALID");
}
export function parseStoreWorkerPackageObservation(
  value: unknown,
): StoreWorkerPackageObservation {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) denied();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) denied();
    const fields = Object.getOwnPropertyDescriptors(value);
    const state = fields.state;
    if (!state?.enumerable || !("value" in state)) denied();
    const names =
      state.value === "installed"
        ? ["version", "state", "package"]
        : state.value === "missing"
          ? ["version", "state"]
          : denied();
    if (
      Reflect.ownKeys(value).length !== names.length ||
      Reflect.ownKeys(value).some(
        (name) => typeof name !== "string" || !names.includes(name),
      )
    )
      denied();
    const row: Record<string, unknown> = Object.create(null);
    for (const name of names) {
      const field = fields[name];
      if (!field?.enumerable || !("value" in field)) denied();
      row[name] = field.value;
    }
    if (row.version !== 1) denied();
    return row.state === "missing"
      ? Object.freeze({ version: 1, state: "missing" })
      : Object.freeze({
          version: 1,
          state: "installed",
          package: parseStoreInstalledPackage("worker", row.package),
        });
  } catch {
    return denied();
  }
}

export function evaluateObservedStoreWorker(
  gui: StoreInstalledPackage,
  observation: StoreWorkerPackageObservation,
): StorePairEvaluation {
  // Re-parse public receiving data. This function cannot manufacture the live
  // native authority used independently at the actual launch boundary.
  const worker = parseStoreWorkerPackageObservation(observation);
  return evaluateStorePackagePair(
    gui,
    worker.state === "installed" ? worker.package : null,
  );
}
