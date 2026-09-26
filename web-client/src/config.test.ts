import { expect, test } from "vitest";
import { validateOrigin } from "./config";

test("API origin rejects credentials, paths and insecure remote hosts", () => {
  expect(validateOrigin("https://api.music-mute.com")).toBe(
    "https://api.music-mute.com",
  );
  expect(validateOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  for (const bad of [
    "http://api.music-mute.com",
    "https://user:pass@api.music-mute.com",
    "https://api.music-mute.com/v1",
  ])
    expect(() => validateOrigin(bad)).toThrow();
});
