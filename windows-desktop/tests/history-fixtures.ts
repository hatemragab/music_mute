import { vi } from "vitest";
import { HistoryController } from "../src/main/history/controller.js";
import {
  AtomicHistoryStore,
  type HistoryFilePort,
} from "../src/main/history/store.js";
import { historyScope } from "../src/main/history/model.js";
import { fleetSid } from "./fleet-fixtures.js";
export const historyDevice = {
  sid: fleetSid,
  installationId: "d7ea7de6-52e9-4b96-8834-3b517941bdb0",
};
export const song = {
  id: "local-cache",
  jobId: "0123456789abcdef01234567",
  title: "Alpha",
};
export function historyFixture(
  device = historyDevice,
  saved = new Map<string, Buffer>(),
) {
  let time = Date.parse("2026-10-09T00:00:00.000Z");
  const files: HistoryFilePort = {
      read: vi.fn(async (path) =>
        saved.has(path) ? Buffer.from(saved.get(path)!) : null,
      ),
      write: vi.fn(async (path, bytes) => {
        saved.set(path, Buffer.from(bytes));
      }),
    },
    store = new AtomicHistoryStore(files),
    controller = new HistoryController({ device, store, now: () => time });
  return {
    controller,
    files,
    store,
    saved,
    device,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    scope: (uid: string | null = null) => historyScope(device, uid),
    primary: (uid: string | null = null) =>
      `history\\${historyScope(device, uid).ownerKey}\\primary.json`,
  };
}
