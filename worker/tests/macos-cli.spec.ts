import { describe, expect, it } from "vitest";
import { macosCommandErrorSummary } from "../src/platform/macos/cli.js";

describe("macOS CLI diagnostics", () => {
  it("returns bounded controlled service errors", () => {
    expect(
      macosCommandErrorSummary(
        new TypeError("Mac runtime binary has a non-private dependency"),
      ),
    ).toBe("Mac runtime binary has a non-private dependency");
  });

  it("does not expose unexpected filesystem error text", () => {
    expect(
      macosCommandErrorSummary(
        new Error("EACCES reading /Users/example/private/machine.credential"),
      ),
    ).toBe("operation failed");
  });
});
