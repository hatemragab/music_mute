import { describe, expect, it } from "vitest";
import { storageErrorCode } from "../src/main/storage/errors.js";

describe("Storage public error projection", () => {
  it("retains only fixed production errors, even for uppercase secret-shaped text", () => {
    expect(storageErrorCode(new Error("STORAGE_SETTINGS_INVALID"))).toBe(
      "STORAGE_SETTINGS_INVALID",
    );
    expect(storageErrorCode(new Error("PRIVATE_ACCESS_TOKEN"))).toBe(
      "STORAGE_UNAVAILABLE",
    );
    expect(storageErrorCode({ message: "STORAGE_SETTINGS_INVALID" })).toBe(
      "STORAGE_UNAVAILABLE",
    );
  });
  it("does not evaluate an error message accessor", () => {
    const error = new Error();
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("private-code-fixture");
      },
    });
    expect(storageErrorCode(error)).toBe("STORAGE_UNAVAILABLE");
  });
});
