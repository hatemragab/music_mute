import {
  isOfflineVocalsBudget,
  OFFLINE_VOCALS_BUDGET_BYTES,
} from "../../../chrome-extension/src/shared/storage-policy.js";
export { OFFLINE_VOCALS_BUDGET_BYTES };
export type StorageCategory =
  | "voices"
  | "originals"
  | "thumbnails"
  | "scratch"
  | "outbox"
  | "runtime"
  | "models"
  | "rollback"
  | "metadata"
  | "unmanaged";
export interface StorageCategoryView {
  category: StorageCategory;
  bytes: number;
  eligibleBytes: number;
  pinnedBytes: number;
  items: number;
}
export interface StorageView {
  state: "loading" | "ready" | "error";
  errorCode: string | null;
  budgetBytes: number;
  voicesBytes: number;
  reservedVoicesBytes: number;
  freeBytes: number | null;
  overBudget: boolean;
  lowSpace: boolean;
  categories: StorageCategoryView[];
  lastCleanup: {
    freedBytes: number;
    removedItems: number;
    deferredItems: number;
  } | null;
}
export type StorageCleanupTarget =
  "voices" | "originals" | "thumbnails" | "scratch" | "all-eligible";
export type StorageCommand =
  | { type: "SCAN" }
  | { type: "SET_BUDGET"; budgetBytes: number }
  | {
      type: "CLEANUP";
      target: StorageCleanupTarget;
      confirmation: "clear-eligible-cache";
    };
export function parseStorageCommand(value: unknown): StorageCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_REQUEST");
  const row = value as Record<string, unknown>;
  if (row.type === "SCAN" && Object.keys(row).join() === "type")
    return { type: "SCAN" };
  if (
    row.type === "SET_BUDGET" &&
    Object.keys(row).sort().join() === "budgetBytes,type" &&
    isOfflineVocalsBudget(row.budgetBytes)
  )
    return row as StorageCommand;
  if (
    row.type === "CLEANUP" &&
    Object.keys(row).sort().join() === "confirmation,target,type" &&
    row.confirmation === "clear-eligible-cache" &&
    ["voices", "originals", "thumbnails", "scratch", "all-eligible"].includes(
      String(row.target),
    )
  )
    return row as StorageCommand;
  throw new Error("INVALID_REQUEST");
}
