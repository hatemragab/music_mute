import { describe, expect, it } from "vitest";
import {
  engineTelemetryEnvironment,
  safeWorkerFramePath,
} from "../src/observability/sentry.js";

describe("worker Sentry privacy", () => {
  it("passes code locations and removes private paths", () => {
    expect(safeWorkerFramePath("C:\\Users\\private\\app\\dist\\src\\runtime.js")).toBe(
      "dist/src/runtime.js",
    );
    expect(safeWorkerFramePath("/Users/private/media/song.wav")).toBe(
      "[external]",
    );
  });

  it("does not enable engine telemetry without a packaged worker", () => {
    expect(engineTelemetryEnvironment()).toEqual({});
  });
});
