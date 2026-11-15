import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  parseSilenceChildConfig,
  parseSilenceChildResult,
  parseSilenceProbe,
  type SilenceChildConfig,
} from "../src/main/player/silence-child.js";
import { parsePreparationChildConfig } from "../src/agent/prepare.js";
import { SILENCE_ANALYSIS_VERSION } from "../src/main/player/silence-analysis.js";
const configuration: SilenceChildConfig = {
  version: 1,
  operation: "silence_analyze",
  requestId: randomUUID(),
  executionId: randomUUID(),
  release: "a".repeat(64),
  sid: "S-1-5-21-1-2-3-1001",
  manifestSha256: "b".repeat(64),
  helperSha256: "c".repeat(64),
  inputBytes: 2000,
  inputSha256: "d".repeat(64),
  durationSeconds: 3600,
};
it("keeps owned silence analysis separate from GPU qualification and cloud limits", () => {
  expect(parseSilenceChildConfig(configuration)).toEqual(configuration);
  expect(() => parsePreparationChildConfig(configuration)).toThrow(
    "PREPARE_CONFIG_INVALID",
  );
  expect(() =>
    parseSilenceChildConfig({ ...configuration, path: "C:\\private.wav" }),
  ).toThrow();
  expect(() =>
    parseSilenceChildConfig({ ...configuration, durationSeconds: 7201 }),
  ).toThrow();
  expect(() =>
    parseSilenceChildConfig({
      ...configuration,
      inputBytes: 256 * 1024 ** 2 + 1,
    }),
  ).toThrow();
});
it("binds analysis output to the exact source digest, execution and detector version", () => {
  const result = {
    version: 1,
    operation: "silence_analyze",
    requestId: configuration.requestId,
    executionId: configuration.executionId,
    inputSha256: configuration.inputSha256,
    durationSeconds: 3600,
    analysisVersion: SILENCE_ANALYSIS_VERSION,
    ranges: [{ start: 2, end: 8 }],
  };
  expect(parseSilenceChildResult(result, configuration).ranges).toEqual([
    { start: 2, end: 8 },
  ]);
  for (const patch of [
    { inputSha256: "f".repeat(64) },
    { executionId: randomUUID() },
    { analysisVersion: "other" },
    { durationSeconds: 4000 },
    { ranges: [{ start: 0, end: 3700 }] },
  ])
    expect(() =>
      parseSilenceChildResult({ ...result, ...patch }, configuration),
    ).toThrow("SILENCE_UNAVAILABLE");
});
it("requires one bounded decoded audio stream with matching duration", () => {
  const probe = {
    format: { duration: "3600" },
    streams: [{ codec_type: "audio", channels: 2, sample_rate: "44100" }],
  };
  expect(() => parseSilenceProbe(probe, 3600)).not.toThrow();
  for (const patch of [
    { streams: [] },
    { streams: [{ codec_type: "audio", channels: 8, sample_rate: "44100" }] },
    { streams: [{ codec_type: "audio", channels: 1, sample_rate: "999" }] },
    { format: { duration: "nan" } },
    { format: { duration: "7201" } },
  ])
    expect(() => parseSilenceProbe({ ...probe, ...patch }, 3600)).toThrow(
      "SILENCE_UNAVAILABLE",
    );
});
