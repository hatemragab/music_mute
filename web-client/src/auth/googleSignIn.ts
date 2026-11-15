type BrowserIdentity = Pick<
  Navigator,
  "userAgent" | "platform" | "maxTouchPoints"
>;

export function usesGoogleRedirect(
  browser: BrowserIdentity = navigator,
): boolean {
  return (
    /Android|iPhone|iPad|iPod/i.test(browser.userAgent) ||
    (browser.platform === "MacIntel" && browser.maxTouchPoints > 1)
  );
}

export function googleSignInErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && code.startsWith("auth/")) return code;
  }
  return "GOOGLE_SIGN_IN_FAILED";
}
