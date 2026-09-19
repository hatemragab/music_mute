import { describe, expect, it } from "vitest";
import { auditMacRuntimeBinary } from "../src/platform/macos/macho-audit.js";

describe.skipIf(process.platform !== "darwin")(
  "macOS Mach-O dependency audit",
  () => {
    it("accepts an ARM64 system binary with only system dependencies", async () => {
      await expect(
        auditMacRuntimeBinary("/usr/bin/true"),
      ).resolves.toBeUndefined();
    });

    it("rejects a Homebrew binary that depends on the mutable global prefix", async () => {
      await expect(
        auditMacRuntimeBinary("/opt/homebrew/bin/node"),
      ).rejects.toThrow("non-private");
    });
  },
);
