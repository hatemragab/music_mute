/** Source-owned fixed locations; never selected by an archive or renderer. */
export const RUNTIME_REPAIR_KEY = "prepare_runtime_repair";
export const RUNTIME_BACKUP_PATH = "staging\\prepare-runtime-backup";
export const RUNTIME_BACKUP_INVENTORY =
  "staging\\prepare-runtime-backup.inventory.json";
export const RUNTIME_BACKUP_INVENTORY_MAX = 16 * 1024 ** 2;
export const RUNTIME_BACKUP_ENTRY_MAX = 100_000;
