import { describe, expect, it } from "vitest";
import {
  engineTelemetryEnvironment,
  safeWorkerFramePath,
  safeRuntimeTags,
} from "../src/observability/sentry.js";

describe("worker Sentry privacy", () => {
  it("retains attempt correlation while dropping diagnostic text and unsafe tags", () => {
    const attemptId = "99f8016b-67f3-4f4b-beb4-205a7b87147e";
    expect(
      safeRuntimeTags({
        attemptId,
        eventKind: "attempt-failed",
        failureCode: "DOWNLOAD_FAILED",
        stage: "input-download",
        detail: "https://storage.invalid/private?secret=x",
        workerId: "/Users/private",
        other: "secret",
      }),
    ).toEqual({
      attemptId,
      eventKind: "attempt-failed",
      failureCode: "DOWNLOAD_FAILED",
      stage: "input-download",
    });
  });

  it("passes code locations and removes private paths", () => {
    expect(
      safeWorkerFramePath("C:\\Users\\private\\app\\dist\\src\\runtime.js"),
    ).toBe("dist/src/runtime.js");
    expect(safeWorkerFramePath("/Users/private/media/song.wav")).toBe(
      "[external]",
    );
  });

  it("does not enable engine telemetry without a packaged worker", () => {
    expect(engineTelemetryEnvironment()).toEqual({});
  });
});
