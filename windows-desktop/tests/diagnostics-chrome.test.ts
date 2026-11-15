import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:path", async (original) => {
  const actual = await original<typeof import("node:path")>();
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.map((p) => p.replaceAll("\\", "/"))),
    },
  };
});
import { storageFixture } from "./storage-fixtures.js";
import { chromeReport, chromeEvent } from "./chrome-diagnostics-fixtures.js";
import { createWindowsChromeDiagnostics } from "../src/main/diagnostics/chrome.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const f = await storageFixture();
  roots.push(f.root);
  const vault = new Map<string, Buffer>(),
    vaultRead = vi.fn(async (ns: string, key: string) => {
      expect(ns).toBe("account");
      return vault.has(key) ? Buffer.from(vault.get(key)!) : null;
    }),
    vaultWrite = vi.fn(async (ns: string, key: string, bytes: Buffer) => {
      expect(ns).toBe("account");
      vault.set(key, Buffer.from(bytes));
    });
  Object.assign(f.native, { vaultRead, vaultWrite });
  const completed = new Set<string>();
  const removeChromeDiagnosticReport = vi.fn(
    async (receipt: string): Promise<"completed" | "pending"> => {
      if (completed.has(receipt)) return "completed";
      const registry = JSON.parse(
          vault.get("chrome_diagnostic_reports")!.toString("utf8"),
        ),
        row = registry.reports.find(
          (r: { receipt: string }) => r.receipt === receipt,
        );
      if (row?.state !== "deleting") throw new Error("VAULT_RECOVERY_REQUIRED");
      const path = join(f.root, "diagnostics", "reports", `${receipt}.json`),
        actual = await lstat(path, { bigint: true });
      for (const [key, value] of Object.entries({
        device: String(actual.dev),
        fileId: String(actual.ino),
        bornAt: String(actual.birthtimeNs),
        bytes: Number(actual.size),
        writtenAt: String(actual.mtimeNs),
        changedAt: String(actual.ctimeNs),
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      }))
        if (row.proof[key] !== value)
          throw new Error("DIAGNOSTICS_REPORT_CHANGED");
      await unlink(path);
      completed.add(receipt);
      return "completed";
    },
  );
  Object.assign(f.native, { removeChromeDiagnosticReport });
  const journal = {
      snapshot: vi.fn(async () => chromeReport([chromeEvent(1, "warning")])),
    },
    reveal = vi.fn(async () => {}),
    options = { host: f.host, journal, storage: f.controller, reveal },
    reporter = await createWindowsChromeDiagnostics(options);
  return {
    ...f,
    vault,
    vaultRead,
    vaultWrite,
    removeChromeDiagnosticReport,
    journal,
    reveal,
    options,
    reporter,
    path: (receipt: string) =>
      join(f.root, "diagnostics", "reports", `${receipt}.json`),
  };
}
it("saves private durable reports, retries one request exactly and restores receipts across GUI lifetimes", async () => {
  const f = await fixture(),
    request = randomUUID(),
    saved: string[] = [],
    stop = f.reporter.subscribeSaved((receipt) => saved.push(receipt));
  const first = await f.reporter.exportReport(
    request,
    new AbortController().signal,
  );
  expect(first.report.privacy).toContain("no-media");
  expect(JSON.stringify(first)).not.toContain(f.root);
  expect(JSON.parse(await readFile(f.path(first.receipt), "utf8"))).toEqual(
    first.report,
  );
  expect(
    await f.reporter.exportReport(request, new AbortController().signal),
  ).toEqual(first);
  expect(f.journal.snapshot).toHaveBeenCalledOnce();
  expect(await f.controller.writes.readOwned()).toEqual([]);
  await f.reporter.show(first.receipt);
  expect(f.reveal).toHaveBeenCalledWith(f.path(first.receipt));
  stop();
  await f.reporter.close();
  const restored = await createWindowsChromeDiagnostics(f.options);
  expect(restored.latestReceipt()).toBe(first.receipt);
  expect(restored.owns(first.receipt)).toBe(true);
  await restored.show(first.receipt);
  expect(saved).toEqual([first.receipt, first.receipt]);
  await restored.close();
});
it("keeps pending native retirement visible and lets close retry the same positive certificate after lost ACK", async () => {
  const f = await fixture();
  for (let i = 0; i < 4; i++)
    await f.reporter.exportReport(randomUUID(), new AbortController().signal);
  const remove = f.removeChromeDiagnosticReport.getMockImplementation()!;
  f.removeChromeDiagnosticReport.mockImplementationOnce(async (id) => {
    await remove(id);
    throw new Error("NATIVE_ACK_LOST");
  });
  await expect(
    f.reporter.exportReport(randomUUID(), new AbortController().signal),
  ).rejects.toThrow("NATIVE_ACK_LOST");
  expect(f.reporter.activity()).toMatchObject({ idle: false });
  f.native.recoverPersonalCleanups.mockRejectedValueOnce(
    new Error("RECEIPT_ACK_LOST"),
  );
  await expect(f.reporter.close()).rejects.toThrow("RECEIPT_ACK_LOST");
  expect(f.reporter.activity().idle).toBe(false);
  await f.reporter.close();
  expect(f.reporter.activity().idle).toBe(true);
  const ids = f.removeChromeDiagnosticReport.mock.calls.map(([id]) => id);
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
});
it("keeps four exact reports, retires old receipts without fallback and preserves reports on admission failure", async () => {
  const f = await fixture(),
    receipts: string[] = [];
  for (let i = 0; i < 4; i++)
    receipts.push(
      (
        await f.reporter.exportReport(
          randomUUID(),
          new AbortController().signal,
        )
      ).receipt,
    );
  const begin = vi
    .spyOn(f.controller, "beginPartialWrite")
    .mockRejectedValueOnce(new Error("STORAGE_WRITE_LIMIT"));
  await expect(
    f.reporter.exportReport(randomUUID(), new AbortController().signal),
  ).rejects.toThrow("STORAGE_WRITE_LIMIT");
  expect(await readdir(join(f.root, "diagnostics", "reports"))).toHaveLength(4);
  begin.mockRestore();
  const latest = await f.reporter.exportReport(
    randomUUID(),
    new AbortController().signal,
  );
  expect(await readdir(join(f.root, "diagnostics", "reports"))).toHaveLength(4);
  expect(f.reporter.owns(receipts[0]!)).toBe(true);
  await expect(f.reporter.show(receipts[0]!)).rejects.toThrow(
    "DIAGNOSTICS_REPORT_MISSING",
  );
  expect(f.reveal).not.toHaveBeenCalled();
  expect(f.reporter.latestReceipt()).toBe(latest.receipt);
  await f.reporter.close();
});
it("recovery reconciles an acknowledged-lost staged WAL without a second snapshot or a second file", async () => {
  const f = await fixture(),
    request = randomUUID(),
    write = f.vaultWrite.getMockImplementation()!;
  f.vaultWrite.mockImplementationOnce(async (ns, key, bytes) => {
    await write(ns, key, bytes);
    throw new Error("fixture lost DPAPI ACK");
  });
  await expect(
    f.reporter.exportReport(request, new AbortController().signal),
  ).rejects.toThrow("fixture lost DPAPI ACK");
  expect(await f.controller.writes.readOwned()).toHaveLength(1);
  await f.reporter.close();
  await f.controller.recoverPartialWrites(
    undefined,
    new AbortController().signal,
  );
  expect(await f.controller.writes.readOwned()).toHaveLength(1);
  expect((await readdir(join(f.root, "diagnostics", "reports")))[0]).toMatch(
    /\.tmp$/u,
  );
  const restored = await createWindowsChromeDiagnostics(f.options),
    result = await restored.exportReport(request, new AbortController().signal);
  expect(f.journal.snapshot).toHaveBeenCalledOnce();
  expect(await readdir(join(f.root, "diagnostics", "reports"))).toEqual([
    `${result.receipt}.json`,
  ]);
  await restored.show(result.receipt);
  await restored.close();
});
it("rejects replaced birth, modified bytes and malformed protected registry before revealing or deleting anything", async () => {
  const f = await fixture(),
    saved = await f.reporter.exportReport(
      randomUUID(),
      new AbortController().signal,
    ),
    path = f.path(saved.receipt),
    bytes = await readFile(path);
  await writeFile(
    path,
    bytes.toString("utf8").replace('"version":1', '"version":2'),
  );
  await expect(f.reporter.show(saved.receipt)).rejects.toThrow(
    "DIAGNOSTICS_REPORT_CHANGED",
  );
  await unlink(path);
  await writeFile(path, bytes);
  await expect(f.reporter.show(saved.receipt)).rejects.toThrow(
    "DIAGNOSTICS_REPORT_CHANGED",
  );
  expect(f.reveal).not.toHaveBeenCalled();
  await f.reporter.close();
  f.vault.set(
    "chrome_diagnostic_reports",
    Buffer.from('{"version":1,"sid":"foreign","reports":[],"retired":[]}'),
  );
  await expect(createWindowsChromeDiagnostics(f.options)).rejects.toThrow(
    "DIAGNOSTICS_REPORT_STATE_INVALID",
  );
  expect((await lstat(path)).isFile()).toBe(true);
});
it("close aborts admission but retains actual activity until the pending snapshot settles", async () => {
  const f = await fixture();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.journal.snapshot.mockImplementationOnce(async () => {
    await held;
    return chromeReport();
  });
  const task = f.reporter.exportReport(
    randomUUID(),
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(f.journal.snapshot).toHaveBeenCalledOnce());
  let closed = false;
  const exact = f.reporter.close();
  expect(f.reporter.close()).toBe(exact);
  const closing = exact.then(() => {
    closed = true;
  });
  expect(f.reporter.activity().idle).toBe(false);
  await Promise.resolve();
  expect(closed).toBe(false);
  finish();
  await expect(task).rejects.toThrow("DIAGNOSTICS_CLOSED");
  await closing;
  expect(f.reporter.activity().idle).toBe(true);
  expect(f.vaultWrite).not.toHaveBeenCalled();
});
it("corrupt DPAPI publication state fences partial recovery instead of erasing a possibly accepted report", async () => {
  const f = await fixture(),
    write = f.vaultWrite.getMockImplementation()!;
  f.vaultWrite.mockImplementationOnce(async (ns, key, bytes) => {
    await write(ns, key, bytes);
    throw new Error("fixture ACK lost");
  });
  await expect(
    f.reporter.exportReport(randomUUID(), new AbortController().signal),
  ).rejects.toThrow("fixture ACK lost");
  await f.reporter.close();
  const names = await readdir(join(f.root, "diagnostics", "reports"));
  f.vault.set(
    "chrome_diagnostic_reports",
    Buffer.from('{"version":1,"version":1}'),
  );
  await expect(
    f.controller.recoverPartialWrites(undefined, new AbortController().signal),
  ).rejects.toThrow("DIAGNOSTICS_REPORT_STATE_INVALID");
  expect(await readdir(join(f.root, "diagnostics", "reports"))).toEqual(names);
});
