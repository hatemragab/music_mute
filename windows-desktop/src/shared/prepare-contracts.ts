export const PREPARE_STAGES = [
  "inspect",
  "space",
  "runtime",
  "model",
  "gpu",
  "activate",
] as const;
export type PrepareStage = (typeof PREPARE_STAGES)[number];
export type PrepareErrorCode =
  | "GPU_UNSUPPORTED"
  | "NETWORK_UNAVAILABLE"
  | "INTEGRITY_INVALID"
  | "LOW_DISK"
  | "NATIVE_HELPER_UNAVAILABLE"
  | "PERMISSION_DENIED"
  | "BUSY"
  | "PREPARE_INTERRUPTED"
  | "OPERATION_FAILED"
  | "JOURNAL_CORRUPT";
export interface PrepareView {
  state: "missing" | "preparing" | "ready" | "cancelled" | "error";
  stage: PrepareStage | null;
  percent: number | null;
  completedBytes: number | null;
  totalBytes: number | null;
  requiredBytes: number | null;
  availableBytes: number | null;
  errorCode: PrepareErrorCode | null;
  /** Trusted model-specific cause; absent/null never authorizes model-folder assistance. */
  errorComponent?: "model" | null;
  browser: "unknown" | "registered" | "attention-needed";
}
