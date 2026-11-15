import { describe, expect, it } from "vitest";
import { parseStrictJson } from "../src/shared/strict-json.js";
import { FrameDecoder, encodeFrame } from "../src/companion/native-protocol.js";
describe("bounded compatible native JSON", () => {
  it("keeps the wire node default while allowing only an explicitly bounded private journal budget", () => {
    const text = JSON.stringify(Array(5000).fill(0));
    expect(() => parseStrictJson(text)).toThrow("INVALID_JSON");
    expect((parseStrictJson(text, 65536, 16384) as unknown[]).length).toBe(
      5000,
    );
    for (const budget of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      16385,
      Number.MAX_SAFE_INTEGER,
    ])
      expect(() => parseStrictJson("{}", 65536, budget)).toThrow(
        "INVALID_JSON",
      );
    expect(() =>
      parseStrictJson(JSON.stringify(Array(16384).fill(0)), 262144, 16384),
    ).toThrow("INVALID_JSON");
  });
  it("preserves finite fractional durations and Unicode", () => {
    const value = {
      duration: 1199.99,
      title: "العربية 🎵",
      flags: [true, false, null],
      number: -1.25e2,
    };
    expect(parseStrictJson(JSON.stringify(value))).toEqual(value);
    expect(new FrameDecoder().push(encodeFrame(value))).toEqual([value]);
    expect(parseStrictJson("0")).toBe(0);
  });
  it.each([
    '{"action":"status","action":"start"}',
    '{"x":1,"\\u0078":2}',
    '{"nested":{"x":1,"x":2}}',
    '{"array":[{"x":1,"x":2}]}',
  ])("rejects duplicate decoded keys: %s", (value) => {
    expect(() => parseStrictJson(value)).toThrow("INVALID_JSON");
    const bytes = Buffer.from(value),
      header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length);
    expect(() =>
      new FrameDecoder().push(Buffer.concat([header, bytes])),
    ).toThrow("INVALID_JSON");
  });
  it.each([
    '{"x":1,}',
    "[1,,2]",
    '{"x":01}',
    '{"x":NaN}',
    '{"x":1e999}',
    '{"x":"\\uZZZZ"}',
    "{} false",
    '{"x":"\n"}',
  ])("rejects malformed/nonfinite JSON %s", (value) => {
    expect(() => parseStrictJson(value)).toThrow("INVALID_JSON");
  });
  it("bounds nesting/nodes/characters and rejects malformed UTF8", () => {
    expect(() =>
      parseStrictJson("[".repeat(34) + "0" + "]".repeat(34)),
    ).toThrow("INVALID_JSON");
    expect(() => parseStrictJson(JSON.stringify(Array(4097).fill(0)))).toThrow(
      "INVALID_JSON",
    );
    expect(() => parseStrictJson('{"x":"' + "a".repeat(65536) + '"}')).toThrow(
      "INVALID_JSON",
    );
    expect(() =>
      new FrameDecoder().push(Buffer.from([2, 0, 0, 0, 0xc0, 0xaf])),
    ).toThrow();
  });
});
