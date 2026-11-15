import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseCloudMediaChildConfig,
  parseCloudProbe,
} from "../src/main/cloud/media-child.js";
import { parseCloudMediaResult } from "../src/main/cloud/media-runner.js";
import { parsePreparationChildConfig } from "../src/agent/prepare.js";
import { fleetSid } from "./fleet-fixtures.js";
function config() {
  return {
    version: 1,
    operation: "cloud_prepare",
    requestId: randomUUID(),
    executionId: randomUUID(),
    release: "a".repeat(64),
    sid: fleetSid,
    manifestSha256: "b".repeat(64),
    helperSha256: "c".repeat(64),
    inputBytes: 1000,
  };
}
describe("fixed CPU media helper contract", () => {
  it("accepts strict cloud preparation without GPU/model fields while qualification still requires GPU", () => {
    const c = config();
    expect(parseCloudMediaChildConfig(c)).toEqual(c);
    expect(() =>
      parseCloudMediaChildConfig({ ...c, path: "C:\\private" }),
    ).toThrow();
    expect(() =>
      parseCloudMediaChildConfig({ ...c, inputBytes: 256 * 1024 ** 2 + 1 }),
    ).toThrow();
    expect(() =>
      parsePreparationChildConfig({ ...c, operation: "qualify" }),
    ).toThrow("PREPARE_CONFIG_INVALID");
  });
  it("binds result to fresh operation execution rather than a stale previous result", () => {
    const c = parseCloudMediaChildConfig(config()),
      result = {
        version: 1,
        operation: c.operation,
        requestId: c.requestId,
        executionId: c.executionId,
        source: "audio_file",
        bytes: 500,
        durationSeconds: 60,
        sha256: Buffer.alloc(32, 1).toString("base64"),
        codec: "aac",
      };
    expect(parseCloudMediaResult(result, c)).toEqual(result);
    for (const row of [
      { ...result, executionId: randomUUID() },
      { ...result, operation: "cloud_probe" },
      { ...result, codec: "mp3" },
      { ...result, bytes: 0 },
    ])
      expect(() => parseCloudMediaResult(row, c)).toThrow(
        "CLOUD_INPUT_INVALID",
      );
  });
  it("validates duration and approved AAC-LC output fields", () => {
    const value = {
      format: { duration: "60" },
      streams: [
        {
          codec_type: "audio",
          codec_name: "aac",
          profile: "LC",
          sample_rate: "44100",
          channels: 2,
        },
      ],
    };
    expect(parseCloudProbe(value, "aac")).toEqual({
      duration: 60,
      source: "audio_file",
    });
    for (const row of [
      { ...value, format: { duration: "1201" } },
      { ...value, streams: [] },
      { ...value, streams: [{ ...value.streams[0], profile: "HE-AAC" }] },
      { ...value, streams: [{ ...value.streams[0], channels: 1 }] },
      { ...value, streams: [...value.streams, { codec_type: "video" }] },
    ])
      expect(() => parseCloudProbe(row, "aac")).toThrow("CLOUD_INPUT_INVALID");
  });
  it("detects video input independently of caller filename and refuses malformed downloaded MP3", () => {
    expect(
      parseCloudProbe({
        format: { duration: "60" },
        streams: [{ codec_type: "audio" }, { codec_type: "video" }],
      }).source,
    ).toBe("video_file");
    expect(() =>
      parseCloudProbe(
        {
          format: { duration: "60" },
          streams: [{ codec_type: "audio", codec_name: "aac" }],
        },
        "mp3",
      ),
    ).toThrow();
  });
});
