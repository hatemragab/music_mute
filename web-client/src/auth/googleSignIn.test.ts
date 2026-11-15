import { expect, test } from "vitest";
import { googleSignInErrorCode, usesGoogleRedirect } from "./googleSignIn";

test.each([
  [
    "iPhone Chrome",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0) CriOS/140.0",
    "iPhone",
    5,
    true,
  ],
  [
    "iPad Safari",
    "Mozilla/5.0 (iPad; CPU OS 26_0) Version/26.0 Safari/605.1",
    "iPad",
    5,
    true,
  ],
  [
    "iPad desktop mode",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1",
    "MacIntel",
    5,
    true,
  ],
  [
    "Android Chrome",
    "Mozilla/5.0 (Linux; Android 16) Chrome/140.0",
    "Linux armv8l",
    5,
    true,
  ],
  [
    "Mac Chrome",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) Chrome/140.0",
    "MacIntel",
    0,
    false,
  ],
  [
    "Windows touchscreen",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0",
    "Win32",
    10,
    false,
  ],
])(
  "%s selects the expected Google sign-in flow",
  (_name, userAgent, platform, maxTouchPoints, expected) => {
    expect(usesGoogleRedirect({ userAgent, platform, maxTouchPoints })).toBe(
      expected,
    );
  },
);

test("Google errors preserve Firebase codes and discard unknown messages", () => {
  expect(
    googleSignInErrorCode({
      code: "auth/network-request-failed",
      message: "private details",
    }),
  ).toBe("auth/network-request-failed");
  expect(googleSignInErrorCode(new Error("private details"))).toBe(
    "GOOGLE_SIGN_IN_FAILED",
  );
  expect(
    googleSignInErrorCode({ code: "unexpected", message: "private details" }),
  ).toBe("GOOGLE_SIGN_IN_FAILED");
});
