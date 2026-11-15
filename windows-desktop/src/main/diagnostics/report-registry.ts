import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import { DIAGNOSTIC_UUID } from "../../shared/diagnostics-contracts.js";
import type { HostContext } from "../host-context.js";
import type { StorageBirth } from "../storage/write-journal.js";
import { CHROME_DIAGNOSTIC_FILE_BYTES } from "./browser-report.js";
export const CHROME_REPORT_KEY = "chrome_diagnostic_reports";
export const CHROME_REPORT_ROOT = "diagnostics\\reports";
interface Proof extends StorageBirth {
  writtenAt: string;
  changedAt: string;
  bytes: number;
  sha256: string;
}
export interface SavedChromeReport {
  requestId: string;
  receipt: string;
  temporary: string;
  state: "staged" | "ready" | "deleting";
  proof: Proof;
}
export interface ChromeReportRegistry {
  version: 1;
  sid: string;
  reports: SavedChromeReport[];
  retired: { requestId: string; receipt: string }[];
}
function invalid(): never {
  throw new Error("DIAGNOSTICS_REPORT_STATE_INVALID");
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).every((k) => typeof k === "string") &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (d) => "value" in d,
    )
  );
}
function dense(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    Object.keys(value).length === value.length &&
    Array.from({ length: value.length }, (_, i) =>
      Object.hasOwn(value, i),
    ).every(Boolean) &&
    Reflect.ownKeys(value).every(
      (k) => typeof k === "string" && (k === "length" || /^\d+$/u.test(k)),
    ) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (d) => "value" in d,
    )
  );
}
export function parseChromeReportRegistry(
  value: unknown,
  sid: string,
): ChromeReportRegistry {
  if (!plain(value)) return invalid();
  const row = value as unknown as ChromeReportRegistry;
  if (
    Object.keys(row).sort().join() !== "reports,retired,sid,version" ||
    row.version !== 1 ||
    row.sid !== sid ||
    !dense(row.reports) ||
    row.reports.length > 4 ||
    !dense(row.retired) ||
    row.retired.length > 64
  )
    return invalid();
  const requests = new Set<string>(),
    receipts = new Set<string>();
  for (const entry of [...row.reports, ...row.retired]) {
    if (
      !plain(entry) ||
      typeof entry.requestId !== "string" ||
      !DIAGNOSTIC_UUID.test(entry.requestId) ||
      typeof entry.receipt !== "string" ||
      !DIAGNOSTIC_UUID.test(entry.receipt) ||
      requests.has(entry.requestId) ||
      receipts.has(entry.receipt)
    )
      return invalid();
    requests.add(entry.requestId);
    receipts.add(entry.receipt);
  }
  for (const entry of row.retired)
    if (Object.keys(entry).sort().join() !== "receipt,requestId")
      return invalid();
  for (const entry of row.reports) {
    const p = entry.proof;
    if (
      Object.keys(entry).sort().join() !==
        "proof,receipt,requestId,state,temporary" ||
      typeof entry.state !== "string" ||
      !["staged", "ready", "deleting"].includes(entry.state) ||
      entry.temporary !==
        `${CHROME_REPORT_ROOT}\\${entry.receipt}.json.${entry.requestId}.tmp` ||
      !plain(p) ||
      Object.keys(p).sort().join() !==
        "bornAt,bytes,changedAt,device,fileId,sha256,writtenAt" ||
      ![p.device, p.fileId, p.bornAt, p.writtenAt, p.changedAt].every(
        (v) => typeof v === "string" && /^\d{1,30}$/u.test(v),
      ) ||
      p.fileId === "0" ||
      !Number.isSafeInteger(p.bytes) ||
      p.bytes < 2 ||
      p.bytes > CHROME_DIAGNOSTIC_FILE_BYTES ||
      typeof p.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(p.sha256)
    )
      return invalid();
  }
  return structuredClone(row);
}
/** Caller holds the existing cache mutex. Never creates an absent registry or repairs invalid state. */
export async function readChromeReportRegistry(
  host: HostContext,
): Promise<ChromeReportRegistry> {
  const bytes = await host.native.vaultRead("account", CHROME_REPORT_KEY);
  if (bytes === null)
    return { version: 1, sid: host.identity.sid, reports: [], retired: [] };
  try {
    if (bytes.length > 16384)
      throw new Error("DIAGNOSTICS_REPORT_STATE_INVALID");
    return parseChromeReportRegistry(
      parseStrictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        16384,
      ),
      host.identity.sid,
    );
  } catch {
    throw new Error("DIAGNOSTICS_REPORT_STATE_INVALID");
  } finally {
    bytes.fill(0);
  }
}
/** A staged DPAPI publication survives dead/settled-copier cleanup until the reporter reconciles it. */
export async function chromeDiagnosticPartialProtected(
  host: HostContext,
  relative: string,
  birth: StorageBirth,
): Promise<boolean> {
  const registry = await readChromeReportRegistry(host),
    row = registry.reports.find(
      (r) => r.temporary === relative && r.state === "staged",
    );
  if (!row) return false;
  if (
    row.proof.device !== birth.device ||
    row.proof.fileId !== birth.fileId ||
    row.proof.bornAt !== birth.bornAt
  )
    throw new Error("STORAGE_WRITE_CHANGED");
  return true;
}
