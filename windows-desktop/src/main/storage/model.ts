import type {
  StorageCategory,
  StorageCategoryView,
  StorageCleanupTarget,
} from "../../shared/storage-contracts.js";
import type { PrivateFileFingerprint } from "../prepare/private-files.js";
import type { ConsumerFileBirth } from "../../../../worker/src/platform/windows/consumer-native.js";
export const STORAGE_FREE_RESERVE_BYTES = 3 * 1024 ** 3;
export const PENDING_ORIGINALS_LIMIT_BYTES = 256 * 1024 ** 2;
export interface StorageFile {
  relativePath: string;
  fingerprint: PrivateFileFingerprint;
}
export interface StorageItem {
  id: string;
  relativePath: string;
  category: StorageCategory;
  bytes: number;
  lastUsed: number;
  eligible: boolean;
  files: StorageFile[];
  directories: string[];
  births?: Record<string, ConsumerFileBirth> | undefined;
}
export const CATEGORIES: StorageCategory[] = [
  "voices",
  "originals",
  "thumbnails",
  "scratch",
  "outbox",
  "runtime",
  "models",
  "rollback",
  "metadata",
  "unmanaged",
];
export function storageTotals(
  items: readonly StorageItem[],
  isPinned: (relative: string) => boolean,
): StorageCategoryView[] {
  return CATEGORIES.map((category) => {
    const rows = items.filter((item) => item.category === category);
    return {
      category,
      bytes: rows.reduce((sum, item) => sum + item.bytes, 0),
      eligibleBytes: rows
        .filter((item) => item.eligible && !isPinned(item.relativePath))
        .reduce((sum, item) => sum + item.bytes, 0),
      pinnedBytes: rows
        .filter((item) => isPinned(item.relativePath))
        .reduce((sum, item) => sum + item.bytes, 0),
      items: rows.length,
    };
  });
}
export function storageEvictionPlan(
  items: readonly StorageItem[],
  limit: number,
  incoming: number,
  reserved: number,
  isPinned: (relative: string) => boolean,
  target?: StorageCleanupTarget,
): StorageItem[] {
  if (
    ![limit, incoming, reserved].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new Error("STORAGE_LIMIT_INVALID");
  let voices =
    items
      .filter((item) => item.category === "voices")
      .reduce((sum, item) => sum + item.bytes, 0) +
    incoming +
    reserved;
  const sorted = items
      .filter((item) => item.eligible && !isPinned(item.relativePath))
      .sort((a, b) => a.lastUsed - b.lastUsed || a.id.localeCompare(b.id)),
    selected: StorageItem[] = [];
  for (const item of sorted) {
    if (target) {
      if (target !== "all-eligible" && item.category !== target) continue;
      selected.push(item);
    } else if (item.category === "voices" && voices > limit) {
      selected.push(item);
      voices -= item.bytes;
    }
  }
  if (!target && voices > limit) throw new Error("OFFLINE_CACHE_FULL");
  return selected;
}
