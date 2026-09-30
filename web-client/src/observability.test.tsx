import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";
import { sanitizeBrowserEvent } from "./observability";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.lang = "en";
});

describe("browser failure recovery", () => {
  it("discards sensitive messages, context and frame queries", () => {
    const safe = sanitizeBrowserEvent({
      type: undefined,
      message: "secret",
      user: { email: "secret@example.com" },
      request: { url: "https://example.com/?token=secret" },
      extra: { token: "secret" },
      breadcrumbs: [{ message: "secret" }],
      exception: {
        values: [
          {
            type: "secret",
            value: "secret",
            stacktrace: {
              frames: [
                {
                  filename: `${location.origin}/assets/app-123.js?token=secret`,
                  function: "secret",
                  lineno: 12,
                },
                {
                  filename: "https://storage.example/file?signature=secret",
                },
              ],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(safe)).not.toContain("secret");
    expect(safe.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      filename: `${location.origin}/assets/app-123.js`,
      lineno: 12,
      colno: undefined,
    });
    expect(safe.exception?.values?.[0]?.stacktrace?.frames?.[1]?.filename).toBe(
      "[external]",
    );
  });

  it.each(["en", "ar"])(
    "recovers a render failure in %s without revealing the error",
    (lang) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      document.documentElement.lang = lang;
      function Broken(): never {
        throw new Error("private filename and token");
      }
      render(
        <ErrorBoundary>
          <Broken />
        </ErrorBoundary>,
      );
      expect(screen.getByRole("alert")).not.toHaveTextContent(
        "private filename",
      );
      expect(
        screen.getByRole("button", {
          name: lang === "ar" ? "إعادة تحميل الصفحة" : "Reload page",
        }),
      ).toBeVisible();
    },
  );
});
