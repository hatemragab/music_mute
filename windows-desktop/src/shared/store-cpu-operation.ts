import {
  parseStoreCpuOperationExpectation as parseReceiving,
  type StoreCpuOperationExpectation,
} from "../../../worker/src/platform/windows/consumer-store-cpu.js";
export {
  STORE_CPU_OPERATIONS,
  type StoreCpuOperationKind,
  type StoreCpuOperationExpectation,
} from "../../../worker/src/platform/windows/consumer-store-cpu.js";
function deny(): never {
  throw new Error("STORE_CPU_OPERATION_INVALID");
}
export function storeCpuFields(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    deny();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    deny();
  const row: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) deny();
    row[key] = d.value;
  }
  return row;
}
/** Receiving data only; this does not construct an operation or prove cleanup. */
export function parseStoreCpuOperationExpectation(
  value: unknown,
  sid: string,
): StoreCpuOperationExpectation {
  const row = parseReceiving(value);
  if (row.nodeOwner.identity.sid !== sid) deny();
  return row;
}
export function parseStoreCpuOperationState(value: unknown): boolean {
  const row = storeCpuFields(value, ["retired"]);
  if (typeof row.retired !== "boolean") deny();
  return row.retired;
}
