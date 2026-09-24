import { describe, expect, it } from "vitest";

import { safeBrowserFramePath } from "./sentry";

describe("dashboard Sentry frame privacy", () => {
  it("keeps only same-origin script paths without query strings", () => {
    expect(safeBrowserFramePath(`${window.location.origin}/assets/app.js?token=private`)).toBe(
      `${window.location.origin}/assets/app.js`,
    );
    expect(safeBrowserFramePath("https://external.example/media/private.mp3")).toBe(
      "[external]",
    );
    expect(safeBrowserFramePath(`${window.location.origin}/user/private-id`)).toBe(
      "[external]",
    );
  });
});
