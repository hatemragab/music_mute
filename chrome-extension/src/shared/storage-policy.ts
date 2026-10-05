export const DECIMAL_GIGABYTE_BYTES = 1_000_000_000;
/** Default aggregate offline vocals budget, shared by desktop and extension. */
export const OFFLINE_VOCALS_BUDGET_BYTES = 2 * DECIMAL_GIGABYTE_BYTES;
/** Largest whole decimal GB whose byte count is exactly representable in JSON/JS. */
export const MAX_OFFLINE_VOCALS_BUDGET_BYTES =
  Math.floor(Number.MAX_SAFE_INTEGER / DECIMAL_GIGABYTE_BYTES) *
  DECIMAL_GIGABYTE_BYTES;

export function isOfflineVocalsBudget(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= DECIMAL_GIGABYTE_BYTES &&
    value <= MAX_OFFLINE_VOCALS_BUDGET_BYTES &&
    value % DECIMAL_GIGABYTE_BYTES === 0
  );
}
