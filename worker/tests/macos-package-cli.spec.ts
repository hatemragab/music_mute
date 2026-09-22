import { describe, expect, it } from "vitest";
import { runMacPackageCommand } from "../src/platform/macos/package-cli.js";

describe("macOS package CLI", () => {
  it("rejects the removed command-style action", async () => {
    await expect(runMacPackageCommand(["install"])).rejects.toThrow(
      "flags require values",
    );
  });

  it("rejects unknown flags before packaging", async () => {
    await expect(
      runMacPackageCommand([
        "--worker-root",
        "/worker",
        "--output",
        "/output",
        "--version",
        "test",
        "--node-root",
        "/node",
        "--python-root",
        "/python",
        "--media-root",
        "/media",
        "--root",
        "/removed-service-root",
      ]),
    ).rejects.toThrow("Unknown macOS package flag: --root");
  });

  it("requires absolute package paths", async () => {
    await expect(
      runMacPackageCommand([
        "--worker-root",
        "worker",
        "--output",
        "/output",
        "--version",
        "test",
        "--node-root",
        "/node",
        "--python-root",
        "/python",
        "--media-root",
        "/media",
      ]),
    ).rejects.toThrow("path must be absolute: --worker-root");
  });
});
