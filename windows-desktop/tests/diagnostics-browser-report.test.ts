import { expect, it } from "vitest";
import { chromeReport, chromeEvent } from "./chrome-diagnostics-fixtures.js";
import { encodeBrowserFrame } from "../src/main/browser/framing.js";
import {
  chromeDiagnosticSummary,
  parseChromeDiagnosticReport,
  parseChromeDiagnosticExport,
  CHROME_DIAGNOSTIC_REPLY_BYTES,
} from "../src/main/diagnostics/browser-report.js";
it("bounds Chrome summaries without discarding aggregate counts, peaks or historical identity alerts", () => {
  const events = Array.from({ length: 500 }, (_, i) => chromeEvent(i + 1)),
    old = chromeEvent(501, "error", "0.0.9"),
    current = chromeEvent(502, "warning"),
    full = chromeReport([...events, old, current]),
    summary = chromeDiagnosticSummary(full);
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(
    CHROME_DIAGNOSTIC_REPLY_BYTES,
  );
  expect(summary.counts).toEqual(full.counts);
  expect(summary.peaks).toEqual(full.peaks);
  expect(summary.recentErrors).toContainEqual(old);
  expect(summary.recentWarnings).toContainEqual(current);
  expect(summary.coverage).toMatchObject({
    truncated: true,
    incompleteHistory: true,
    readOnly: true,
  });
  expect(full.recentEvents.length).toBeGreaterThan(summary.recentEvents.length);
  const reply = {
    protocol_version: 1,
    request_id: "00000000-0000-4000-8000-000000000000",
    type: "REPORT",
    payload: { report: summary },
  };
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(32768);
  const encoded = encodeBrowserFrame(reply);
  expect(encoded.readUInt32LE(0)).toBe(encoded.length - 4);
});
it("rejects unknown/private fields, getters, coercion, sparse records and oversized replies", () => {
  const full = chromeReport([chromeEvent(1)]),
    getter = { ...full },
    evil = {
      toString() {
        throw new Error("must not execute coercion");
      },
    };
  Object.defineProperty(getter, "identity", {
    get() {
      throw new Error("must not execute getter");
    },
    enumerable: true,
  });
  for (const value of [
    { ...full, path: "C:\\secret" },
    getter,
    { ...full, identity: { ...full.identity, runtimeScope: evil } },
    { ...full, recentEvents: [{ ...full.recentEvents[0], phase: evil }] },
    { ...full, jobs: Object.assign([], { length: 1 }) },
    { ...full, counts: { "runtime.secret": 1 } },
    { ...full, peaks: { token: 1 } },
    {
      ...full,
      recentEvents: [{ ...full.recentEvents[0], metrics: { path: "secret" } }],
    },
  ])
    expect(() => parseChromeDiagnosticReport(value)).toThrow();
  expect(() =>
    parseChromeDiagnosticExport({
      report: chromeReport(
        Array.from({ length: 500 }, (_, i) => chromeEvent(i + 1)),
      ),
      receipt: "00000000-0000-4000-8000-000000000000",
    }),
  ).toThrow("DIAGNOSTICS_REPORT_TOO_LARGE");
});
