import { CONSUMER_NATIVE_ERROR_CODES } from "../../../../worker/src/platform/windows/consumer-native-policy.js";

const CODES = new Set<string>([
  ...CONSUMER_NATIVE_ERROR_CODES,
  "DISK_SPACE_LOW",
  "DISK_SPACE_UNAVAILABLE",
  "INPUT_LIMIT",
  "LIBRARY_BUSY",
  "LIBRARY_MEDIA_PINNED",
  "LIBRARY_PINS_INVALID",
  "LIBRARY_PIN_LIMIT",
  "LIBRARY_PIN_OWNER_INVALID",
  "OFFLINE_CACHE_FULL",
  "OUTBOX_FULL",
  "OUTBOX_STORAGE_INVALID",
  "SHARE_UNAVAILABLE",
  "STORAGE_ACCESS_INVALID",
  "STORAGE_DELETE_UNCONFIRMED",
  "STORAGE_INVENTORY_LIMIT",
  "STORAGE_ITEM_CHANGED",
  "STORAGE_ITEM_PROTECTED",
  "STORAGE_LIMIT_INVALID",
  "STORAGE_MEDIA_INVALID",
  "STORAGE_NOT_READY",
  "STORAGE_OWNER_INVALID",
  "STORAGE_RECOVERY_PENDING",
  "STORAGE_RESERVATIONS_INVALID",
  "STORAGE_RESERVATION_LIMIT",
  "STORAGE_SCRATCH_CHANGED",
  "STORAGE_SCRATCH_FULL",
  "STORAGE_SCRATCH_INVALID",
  "STORAGE_SETTINGS_INVALID",
  "STORAGE_UNSAFE",
  "STORAGE_WORKSPACE_CHANGED",
  "STORAGE_WORKSPACE_INVALID",
  "STORAGE_WRITE_CHANGED",
  "STORAGE_WRITE_INVALID",
  "STORAGE_WRITE_LIMIT",
  "STORAGE_UNAVAILABLE",
]);

/** Public views never copy arbitrary error text or execute a message accessor. */
export function storageErrorCode(value: unknown): string {
  if (!(value instanceof Error)) return "STORAGE_UNAVAILABLE";
  const message = Object.getOwnPropertyDescriptor(value, "message");
  return message &&
    "value" in message &&
    typeof message.value === "string" &&
    CODES.has(message.value)
    ? message.value
    : "STORAGE_UNAVAILABLE";
}
