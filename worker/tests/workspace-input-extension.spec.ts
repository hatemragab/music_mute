import { expect, it, vi } from "vitest";
import { attemptInputExtension } from "../src/runtime/workspace.js";

it.each(["constructor", "__proto__", "toString", "application/octet-stream"])(
  "uses the decoder fallback for unknown MIME %s without inherited object members",
  (contentType) => {
    expect(attemptInputExtension(contentType)).toBe(".bin");
  },
);
it("preserves case-insensitive known MIME filenames and rejects coercion", () => {
  expect(attemptInputExtension("AUDIO/MP4")).toBe(".m4a");
  const toString = vi.fn(() => "audio/mpeg");
  expect(() =>
    attemptInputExtension({ toString } as unknown as string),
  ).toThrow("Input content type is invalid");
  expect(toString).not.toHaveBeenCalled();
});
