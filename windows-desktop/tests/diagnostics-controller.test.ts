import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { WindowsDiagnosticsController } from "../src/main/diagnostics/controller.js";
import { diagnosticReport } from "../src/main/diagnostics/projection.js";
import { diagnosticIdentity } from "./diagnostics-fixtures.js";
const report = () =>
  diagnosticReport({
    events: [],
    identity: diagnosticIdentity,
    now: 1700000000000,
    availability: "no-logs",
    failureCode: null,
    malformed: 0,
    recovered: 0,
    rejected: 0,
    failedWrites: 0,
    retained: 0,
    maximum: 1048576,
    incomplete: false,
  });
it("copy/export/reveal/show use narrow trusted OS ports and never claim failed export as a receipt", async () => {
  const id = randomUUID(),
    journal = {
      snapshot: vi.fn(async () => report()),
      clear: vi.fn(async () => {}),
    },
    os = {
      copy: vi.fn(async () => {}),
      export: vi.fn(async () => ({ receipt: id })),
      revealLogs: vi.fn(async () => {}),
      showReport: vi.fn(async () => {}),
    },
    controller = new WindowsDiagnosticsController(
      journal,
      { run: vi.fn() },
      os,
    );
  await controller.initialize();
  await expect(controller.execute({ type: "SHOW_REPORT" })).rejects.toThrow(
    "DIAGNOSTICS_REPORT_MISSING",
  );
  await controller.execute({ type: "COPY" });
  expect(os.copy).toHaveBeenCalledOnce();
  await controller.execute({
    type: "EXPORT",
    destinationCapability: randomUUID(),
  });
  expect(controller.snapshot().exportReceipt).toBe(id);
  await controller.execute({ type: "SHOW_REPORT" });
  expect(os.showReport).toHaveBeenCalledWith(id);
  await controller.execute({ type: "REVEAL_LOGS" });
  expect(os.revealLogs).toHaveBeenCalledOnce();
  os.export.mockRejectedValueOnce(
    new Error("C:\\Users\\private\\path?token=secret"),
  );
  await expect(
    controller.execute({ type: "EXPORT", destinationCapability: randomUUID() }),
  ).rejects.toThrow("DIAGNOSTICS_UNAVAILABLE");
  expect(controller.snapshot().problem).toBe("DIAGNOSTICS_UNAVAILABLE");
  expect(controller.snapshot().exportReceipt).toBe(id);
  await controller.execute({ type: "CLEAR" });
  expect(journal.clear).toHaveBeenCalledOnce();
  await controller.dispose();
});
it("dispose aborts Doctor but waits its real teardown; activity remains nonidle until it settles", async () => {
  let finish!: () => void, signal: AbortSignal | undefined;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const controller = new WindowsDiagnosticsController(
    { snapshot: async () => report(), clear: async () => {} },
    {
      run: async (_full, s) => {
        signal = s;
        await held;
        s.throwIfAborted();
        throw new Error();
      },
    },
    {
      copy: async () => {},
      export: async () => ({ receipt: randomUUID() }),
      revealLogs: async () => {},
      showReport: async () => {},
    },
  );
  const task = controller.execute({ type: "DOCTOR" });
  await Promise.resolve();
  const close = controller.dispose();
  expect(signal?.aborted).toBe(true);
  expect(controller.activity().idle).toBe(false);
  let closed = false;
  void close.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  finish();
  await task.catch(() => {});
  await close;
  expect(controller.activity().idle).toBe(true);
});
it("accepts a trusted local Chrome receipt without changing GUI export consent or exposing a renderer receipt setter", async () => {
  const os = {
      copy: vi.fn(),
      export: vi.fn(),
      revealLogs: vi.fn(),
      showReport: vi.fn(async () => {}),
    },
    controller = new WindowsDiagnosticsController(
      { snapshot: async () => report(), clear: async () => {} },
      { run: vi.fn() },
      os,
    ),
    receipt = randomUUID();
  controller.acceptLocalReport(receipt);
  expect(controller.snapshot().exportReceipt).toBe(receipt);
  expect(os.export).not.toHaveBeenCalled();
  await controller.execute({ type: "SHOW_REPORT" });
  expect(os.showReport).toHaveBeenCalledWith(receipt);
  expect(() =>
    controller.acceptLocalReport("C:\\private\\report.json"),
  ).toThrow("DIAGNOSTICS_EXPORT_FAILED");
  await expect(
    controller.execute({ type: "ACCEPT_LOCAL_REPORT", receipt }),
  ).rejects.toThrow("DIAGNOSTICS_REQUEST_INVALID");
  await controller.dispose();
  expect(() => controller.acceptLocalReport(receipt)).toThrow(
    "DIAGNOSTICS_CLOSED",
  );
});
