import { MVP_MAX_DURATION_SECONDS } from "../shared/protocol.js";

export interface BenchmarkOptions {
  duration_seconds: number;
  sample_rate: 32_000 | 44_100 | 48_000;
  input_format: "wav" | "mp3";
}

/** A developer harness remains bounded even when explicitly qualifying long clips. */
export function parseBenchmarkOptions(args: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    duration_seconds: 10,
    sample_rate: 44_100,
    input_format: "wav",
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value || seen.has(flag))
      throw new Error("INVALID_BENCHMARK_OPTIONS");
    seen.add(flag);
    if (flag === "--duration") {
      if (
        !/^\d{1,4}$/.test(value) ||
        Number(value) < 10 ||
        Number(value) > MVP_MAX_DURATION_SECONDS
      )
        throw new Error("INVALID_BENCHMARK_OPTIONS");
      options.duration_seconds = Number(value);
    } else if (flag === "--sample-rate") {
      if (!["32000", "44100", "48000"].includes(value))
        throw new Error("INVALID_BENCHMARK_OPTIONS");
      options.sample_rate = Number(value) as BenchmarkOptions["sample_rate"];
    } else if (flag === "--format") {
      if (value !== "wav" && value !== "mp3")
        throw new Error("INVALID_BENCHMARK_OPTIONS");
      options.input_format = value;
    } else throw new Error("INVALID_BENCHMARK_OPTIONS");
  }
  return options;
}
