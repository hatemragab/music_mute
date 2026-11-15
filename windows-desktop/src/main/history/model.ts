import { createHash } from "node:crypto";
import type {
  HistoryEntryView,
  HistoryTrack,
} from "../../shared/history-contracts.js";
export const HISTORY_MAX_BYTES = 2 * 1024 ** 2;
export const HISTORY_MAX_ENTRIES = 4096;
export const HISTORY_MAX_CATALOG = 8192;
export const HISTORY_MAX_RECEIPTS = 8192;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
export interface HistoryScope {
  deviceKey: string;
  ownerKey: string;
}
export interface HistoryReceipt {
  sessionId: string;
  trackId: string;
}
export interface HistoryRecord {
  version: 1;
  deviceKey: string;
  ownerKey: string;
  revision: number;
  entries: HistoryEntryView[];
  receipts: HistoryReceipt[];
}
export function historyScope(
  device: { sid: string; installationId: string },
  uid: string | null,
): HistoryScope {
  if (
    !/^S-1-5-21-(?:\d+-){2}\d+-\d+$/.test(device.sid) ||
    !UUID.test(device.installationId) ||
    (uid !== null &&
      (uid.length < 1 || uid.length > 128 || /[\p{Cc}\p{Cf}]/u.test(uid)))
  )
    throw new Error("HISTORY_SCOPE_INVALID");
  const deviceKey = createHash("sha256")
    .update(JSON.stringify([device.sid, device.installationId.toLowerCase()]))
    .digest("hex");
  return {
    deviceKey,
    ownerKey: createHash("sha256")
      .update(
        JSON.stringify([deviceKey, uid === null ? "local" : "account", uid]),
      )
      .digest("hex"),
  };
}
export function historyTrack(value: HistoryTrack): HistoryTrack {
  const alias = (v: unknown) =>
    typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
  if (
    !value ||
    !alias(value.id) ||
    (value.jobId != null && !alias(value.jobId)) ||
    typeof value.title !== "string" ||
    value.title.length > 300 ||
    /[\p{Cc}]/u.test(value.title)
  )
    throw new Error("HISTORY_TRACK_INVALID");
  return { id: value.id, jobId: value.jobId ?? null, title: value.title };
}
export function trackAliases(track: HistoryTrack): string[] {
  return [...new Set([track.id, ...(track.jobId ? [track.jobId] : [])])].sort();
}
export function validSession(value: string): string {
  if (!UUID.test(value)) throw new Error("HISTORY_SESSION_INVALID");
  return value.toLowerCase();
}
export function emptyHistory(scope: HistoryScope): HistoryRecord {
  return { version: 1, ...scope, revision: 0, entries: [], receipts: [] };
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(row: Record<string, unknown>, names: string[]): boolean {
  return (
    Object.keys(row).length === names.length &&
    names.every((k) => Object.hasOwn(row, k))
  );
}
function validAlias(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}
export function parseHistoryRecord(
  value: unknown,
  scope: HistoryScope,
): HistoryRecord {
  if (!object(value)) throw new Error("HISTORY_CORRUPT");
  if (value.version !== 1) throw new Error("HISTORY_VERSION_UNSUPPORTED");
  if (
    !keys(value, [
      "version",
      "deviceKey",
      "ownerKey",
      "revision",
      "entries",
      "receipts",
    ]) ||
    value.deviceKey !== scope.deviceKey ||
    value.ownerKey !== scope.ownerKey ||
    !HASH.test(scope.deviceKey) ||
    !HASH.test(scope.ownerKey) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.entries) ||
    value.entries.length > HISTORY_MAX_ENTRIES ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > HISTORY_MAX_RECEIPTS
  )
    throw new Error("HISTORY_CORRUPT");
  const aliases = new Set<string>();
  for (const row of value.entries) {
    if (
      !object(row) ||
      !keys(row, [
        "aliases",
        "count",
        "lastListenedAt",
        "listenedSeconds",
        "lastPosition",
      ]) ||
      !Array.isArray(row.aliases) ||
      row.aliases.length < 1 ||
      row.aliases.length > 8 ||
      !row.aliases.every(validAlias) ||
      new Set(row.aliases).size !== row.aliases.length ||
      !Number.isSafeInteger(row.count) ||
      (row.count as number) < 1 ||
      typeof row.lastListenedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        row.lastListenedAt,
      ) ||
      !Number.isFinite(Date.parse(row.lastListenedAt)) ||
      new Date(row.lastListenedAt).toISOString() !== row.lastListenedAt ||
      !Number.isFinite(row.listenedSeconds) ||
      (row.listenedSeconds as number) < 0 ||
      (row.listenedSeconds as number) > Number.MAX_SAFE_INTEGER ||
      !Number.isFinite(row.lastPosition) ||
      (row.lastPosition as number) < 0 ||
      (row.lastPosition as number) > 7200
    )
      throw new Error("HISTORY_CORRUPT");
    for (const alias of row.aliases) {
      if (aliases.has(alias)) throw new Error("HISTORY_CORRUPT");
      aliases.add(alias);
    }
  }
  const ids = new Set<string>();
  for (const row of value.receipts) {
    if (
      !object(row) ||
      !keys(row, ["sessionId", "trackId"]) ||
      typeof row.sessionId !== "string" ||
      !UUID.test(row.sessionId) ||
      row.sessionId !== row.sessionId.toLowerCase() ||
      !validAlias(row.trackId) ||
      !aliases.has(row.trackId) ||
      ids.has(row.sessionId)
    )
      throw new Error("HISTORY_CORRUPT");
    ids.add(row.sessionId);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > HISTORY_MAX_BYTES)
    throw new Error("HISTORY_CAPACITY_REACHED");
  return structuredClone(value) as unknown as HistoryRecord;
}
export function encodeHistory(record: HistoryRecord): Buffer {
  parseHistoryRecord(record, record);
  const bytes = Buffer.from(JSON.stringify(record));
  const out = Buffer.from(
    JSON.stringify({
      checksum: createHash("sha256").update(bytes).digest("hex"),
      record,
    }),
  );
  if (out.length > HISTORY_MAX_BYTES)
    throw new Error("HISTORY_CAPACITY_REACHED");
  return out;
}
export function decodeHistory(
  bytes: Buffer,
  scope: HistoryScope,
): HistoryRecord {
  if (bytes.length > HISTORY_MAX_BYTES) throw new Error("HISTORY_CORRUPT");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("HISTORY_CORRUPT");
  }
  if (
    !object(value) ||
    !keys(value, ["checksum", "record"]) ||
    typeof value.checksum !== "string" ||
    createHash("sha256").update(JSON.stringify(value.record)).digest("hex") !==
      value.checksum
  )
    throw new Error("HISTORY_CORRUPT");
  return parseHistoryRecord(value.record, scope);
}
/** Linked cache/job identities share the larger prior value, just as DesktopPlayHistory. */
export function reconcileAliases(
  record: HistoryRecord,
  aliases: string[],
): HistoryEntryView | undefined {
  const union = new Set(aliases),
    selected: HistoryEntryView[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of record.entries)
      if (!selected.includes(row) && row.aliases.some((a) => union.has(a))) {
        selected.push(row);
        for (const a of row.aliases) union.add(a);
        changed = true;
      }
  }
  if (!selected.length) return undefined;
  if (
    selected.length === 1 &&
    selected[0]!.aliases.length === union.size &&
    selected[0]!.aliases.every((alias) => union.has(alias))
  )
    return selected[0];
  if (union.size > 8) throw new Error("HISTORY_CAPACITY_REACHED");
  const latest = selected.reduce((a, b) =>
      a.lastListenedAt >= b.lastListenedAt ? a : b,
    ),
    merged: HistoryEntryView = {
      aliases: [...union].sort(),
      count: Math.max(...selected.map((r) => r.count)),
      lastListenedAt: latest.lastListenedAt,
      listenedSeconds: Math.max(...selected.map((r) => r.listenedSeconds)),
      lastPosition: latest.lastPosition,
    };
  record.entries = [
    ...record.entries.filter((r) => !selected.includes(r)),
    merged,
  ];
  return merged;
}
