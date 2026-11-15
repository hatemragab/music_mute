import { describe, expect, it } from "vitest";
import {
  storageEvictionPlan,
  storageTotals,
  type StorageItem,
} from "../src/main/storage/model.js";
import {
  parseStorageCommand,
  OFFLINE_VOCALS_BUDGET_BYTES,
} from "../src/shared/storage-contracts.js";
const item = (
  id: string,
  bytes: number,
  lastUsed: number,
  eligible = true,
  category: StorageItem["category"] = "voices",
): StorageItem => ({
  id,
  relativePath: id,
  category,
  bytes,
  lastUsed,
  eligible,
  files: [],
  directories: [],
});
describe("storage decimal-GB/LRU policy", () => {
  it("retains2decimalGB default and accepts onlypositivewholeGB settings", () => {
    expect(OFFLINE_VOCALS_BUDGET_BYTES).toBe(2000000000);
    expect(
      parseStorageCommand({ type: "SET_BUDGET", budgetBytes: 3000000000 }),
    ).toMatchObject({ budgetBytes: 3000000000 });
    for (const budgetBytes of [0, 1, 1.5e9, 2 * 1024 ** 3, NaN])
      expect(() =>
        parseStorageCommand({ type: "SET_BUDGET", budgetBytes }),
      ).toThrow("INVALID_REQUEST");
  });
  it("evicts oldest eligible voices deterministically and respects reservations/pins", () => {
    const rows = [
      item("new", 30, 3),
      item("old", 30, 1),
      item("pinned", 30, 0),
      item("original", 200, 0, true, "originals"),
    ];
    expect(
      storageEvictionPlan(rows, 90, 30, 0, (id) => id === "pinned").map(
        (row) => row.id,
      ),
    ).toEqual(["old"]);
    expect(() =>
      storageEvictionPlan(rows, 30, 30, 30, (id) => id === "pinned"),
    ).toThrow("OFFLINE_CACHE_FULL");
    expect(
      storageTotals(rows, (id) => id === "pinned").find(
        (row) => row.category === "originals",
      )?.bytes,
    ).toBe(200);
  });
  it("preserves unmanaged/runtime/models/outboxes and separates explicitoriginalcleanup", () => {
    const rows = [
      item("voice", 30, 1),
      item("original", 20, 0, true, "originals"),
      item("runtime", 100, 0, false, "runtime"),
      item("outbox", 100, 0, false, "outbox"),
    ];
    expect(
      storageEvictionPlan(rows, 30, 0, 0, () => false, "originals").map(
        (row) => row.id,
      ),
    ).toEqual(["original"]);
    expect(
      storageEvictionPlan(rows, 30, 0, 0, () => false, "all-eligible").map(
        (row) => row.id,
      ),
    ).toEqual(["original", "voice"]);
    expect(() =>
      parseStorageCommand({
        type: "CLEANUP",
        target: "all-eligible",
        confirmation: "delete-everything",
      }),
    ).toThrow("INVALID_REQUEST");
  });
});
