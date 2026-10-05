import { describe, expect, it } from "vitest";
import { parseBenchmarkOptions } from "../src/companion/benchmark-options.js";

describe("bounded actual-engine qualification", () => {
  it("keeps the inexpensive ten-second default", () => {
    expect(parseBenchmarkOptions([])).toEqual({
      duration_seconds: 10,
      sample_rate: 44_100,
      input_format: "wav",
    });
  });
  it("admits explicit five/twenty minute and resampling/decoder qualification", () => {
    expect(
      parseBenchmarkOptions([
        "--duration",
        "300",
        "--sample-rate",
        "48000",
        "--format",
        "mp3",
      ]),
    ).toEqual({
      duration_seconds: 300,
      sample_rate: 48_000,
      input_format: "mp3",
    });
    expect(parseBenchmarkOptions(["--duration", "1200"]).duration_seconds).toBe(
      1200,
    );
  });
  it.each([
    ["--duration", "1201"],
    ["--duration", "9"],
    ["--duration", "NaN"],
    ["--duration", "300.5"],
    ["--duration", "1e3"],
    ["--duration"],
    ["--duration", "300", "--duration", "900"],
    ["--sample-rate", "192000"],
    ["--format", "video"],
    ["--input", "/arbitrary/path"],
  ])("rejects unsafe or ambiguous options %j", (...args: string[]) => {
    expect(() => parseBenchmarkOptions(args)).toThrow(
      "INVALID_BENCHMARK_OPTIONS",
    );
  });
});
