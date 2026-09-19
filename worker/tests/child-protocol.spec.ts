import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CHILD_FRAME_MAX_BYTES,
  ChildFrameDecoder,
  ChildProtocolError,
  encodeChildFrame,
  parseChildMessage,
  type ChildRequest,
} from "../src/agent/ipc/child-protocol.js";

function request(overrides: Partial<ChildRequest> = {}): ChildRequest {
  return {
    protocolVersion: 1,
    type: "request",
    command: "ping",
    requestId: randomUUID(),
    incarnation: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: {},
    ...overrides,
  };
}

describe("child pipe protocol", () => {
  it("decodes fragmented and consecutive length-prefixed frames", () => {
    const first = request();
    const second = request();
    const bytes = Buffer.concat([
      encodeChildFrame(first),
      encodeChildFrame(second),
    ]);
    const decoder = new ChildFrameDecoder();
    expect(decoder.push(bytes.subarray(0, 3))).toEqual([]);
    expect(decoder.push(bytes.subarray(3, 17))).toEqual([]);
    expect(decoder.push(bytes.subarray(17))).toEqual([first, second]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("rejects unknown fields, invalid cancellation and deep payloads", () => {
    expect(() =>
      parseChildMessage({ ...request(), credential: "must-not-cross" }),
    ).toThrow(ChildProtocolError);
    expect(() =>
      parseChildMessage({
        ...request({ command: "cancel" }),
        payload: { targetRequestId: "not-a-uuid" },
      }),
    ).toThrow("Cancellation target");
    expect(() =>
      parseChildMessage({
        ...request(),
        payload: {
          a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } },
        },
      }),
    ).toThrow("deeply nested");
  });

  it("rejects oversized declarations before buffering their body", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(CHILD_FRAME_MAX_BYTES + 1);
    expect(() => new ChildFrameDecoder().push(header)).toThrow(
      "invalid byte length",
    );
  });

  it("rejects a stream that ends in a partial frame", () => {
    const frame = encodeChildFrame(request());
    const decoder = new ChildFrameDecoder();
    decoder.push(frame.subarray(0, frame.length - 1));
    expect(() => decoder.finish()).toThrow("incomplete frame");
  });
});
