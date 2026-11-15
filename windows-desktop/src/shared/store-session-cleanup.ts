import { storeCpuFields } from "./store-cpu-operation.js";

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
/** Closed receiving classification only. Native still requires its genuine
 * client, original request/row and critical code; this grants no new work. */
export function isStoreSessionCleanupCommand(value: unknown): boolean {
  try {
    const action =
      value && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "action")?.value
        : undefined;
    const field =
      action === "prepare_cancel" ||
      action === "cpu_cancel" ||
      action === "benchmark_cancel"
        ? "launch"
        : action === "cpu_recover" || action === "benchmark_recover"
          ? "request"
          : action === "cpu_operation_inspect"
            ? "expectation"
            : undefined;
    if (!field && action !== "session_forward_ack") return false;
    const row = storeCpuFields(value, [
      "version",
      "requestId",
      "action",
      ...(field ? [field] : []),
    ]);
    return (
      row.version === 1 &&
      typeof row.requestId === "string" &&
      UUID.test(row.requestId) &&
      (!field ||
        (row[field] !== null &&
          typeof row[field] === "object" &&
          !Array.isArray(row[field])))
    );
  } catch {
    return false;
  }
}
