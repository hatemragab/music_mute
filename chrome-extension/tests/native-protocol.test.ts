import { describe, it, expect } from "vitest";
import {
  encodeFrame,
  FrameDecoder,
  validateCommand,
} from "../src/companion/native-protocol.js";
describe("native protocol fences", () => {
  const valid = {
    protocol_version: 1,
    request_id: "11111111-1111-4111-8111-111111111111",
    type: "START",
    payload: {
      video_id: "BaW_jenozKc",
      duration_seconds: 10,
      provider: "LOCAL_MACOS",
    },
  };
  it("decodes split frames and rejects oversized/truncated input", () => {
    const frame = encodeFrame(valid);
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toEqual([valid]);
    decoder.finish();
    const bad = Buffer.alloc(4);
    bad.writeUInt32LE(1024 * 1024);
    expect(() => new FrameDecoder().push(bad)).toThrow("FRAME_INVALID");
    const partial = new FrameDecoder();
    partial.push(frame.subarray(0, 5));
    expect(() => partial.finish()).toThrow("FRAME_TRUNCATED");
  });
  it("rejects unbounded videos, arbitrary downloader paths/URLs, unsupported protocol and malformed IDs", () => {
    expect(validateCommand(valid)).toEqual(valid);
    const maximum = {
      ...valid,
      payload: { ...valid.payload, duration_seconds: 1200 },
    };
    expect(validateCommand(maximum)).toEqual(maximum);
    for (const change of [
      { video_id: "../../file" },
      { duration_seconds: Infinity },
      { duration_seconds: 1201 },
      { url: "http://localhost/" },
      { cookies: "synthetic-account-canary" },
      { cookies_from_browser: "chrome" },
      {
        headers: {
          Cookie: "synthetic-account-canary",
          Authorization: "synthetic-account-canary",
        },
      },
      { visitor_data: "synthetic-account-canary" },
      { po_token: "synthetic-account-canary" },
      { username: "synthetic-account-canary" },
      { password: "synthetic-account-canary" },
      { provider: "ANY" },
    ])
      expect(() =>
        validateCommand({ ...valid, payload: { ...valid.payload, ...change } }),
      ).toThrow();
    expect(() => validateCommand({ ...valid, protocol_version: 2 })).toThrow();
  });
  it("negotiates only reviewed additive capabilities, retaining the empty legacy hello", () => {
    for (const payload of [
      {},
      { capabilities: ["error_context_v1"] },
      { capabilities: ["error_context_v1", "cloud_handoff_v1"] },
      {
        capabilities: [
          "error_context_v1",
          "cloud_handoff_v1",
          "processing_selection_v1",
        ],
      },
      {
        capabilities: [
          "error_context_v1",
          "cloud_handoff_v1",
          "processing_selection_v1",
          "background_publication_v1",
        ],
      },
    ])
      expect(validateCommand({ ...valid, type: "HELLO", payload })).toEqual({
        ...valid,
        type: "HELLO",
        payload,
      });
    for (const payload of [
      { capabilities: "error_context_v1" },
      { capabilities: ["error_context_v1", "error_context_v1"] },
      { capabilities: ["private_url"] },
      { capabilities: [], cookies: "secret" },
    ])
      expect(() =>
        validateCommand({ ...valid, type: "HELLO", payload }),
      ).toThrow("INVALID_COMMAND");
  });
  it("bounds playback acknowledgement to the exact native job and video identity", () => {
    const command = {
      ...valid,
      type: "PLAYBACK_STARTED",
      payload: {
        job_id: "22222222-2222-4222-8222-222222222222",
        video_id: "BaW_jenozKc",
      },
    };
    expect(validateCommand(command)).toEqual(command);
    for (const payload of [
      {},
      { ...command.payload, job_id: "private-path" },
      { ...command.payload, video_id: "other" },
      { ...command.payload, video_id: "BaW_jenozKc\n" },
      { ...command.payload, media_url: "private" },
    ])
      expect(() => validateCommand({ ...command, payload })).toThrow(
        "INVALID_COMMAND",
      );
  });
  it("keeps cloud START bounded to the same public identity contract", () => {
    const online = {
      ...valid,
      payload: { ...valid.payload, provider: "ONLINE_MUSICMUTE" },
    };
    expect(validateCommand(online)).toEqual(online);
    expect(() =>
      validateCommand({
        ...online,
        payload: { ...online.payload, id_token: "never-native-browser" },
      }),
    ).toThrow("INVALID_COMMAND");
  });
});
