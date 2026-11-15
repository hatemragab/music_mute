import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { LocalSetupError as ConfigSetupError } from "../src/companion/config.js";
import { LocalSetupError } from "../src/companion/local-setup-error.js";

describe("setup error initialization", () => {
  it("preserves the existing config export and error identity", () => {
    expect(ConfigSetupError).toBe(LocalSetupError);
    const error = new LocalSetupError("MODEL_DOWNLOAD_FAILED");
    expect(error).toBeInstanceOf(ConfigSetupError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("MODEL_DOWNLOAD_FAILED");
    expect(error.message).toBe("MODEL_DOWNLOAD_FAILED");
    expect(error.name).toBe("LocalSetupError");
  });

  it("starts the actual bundled Mac controller before rejecting an invalid command", async () => {
    const result = await build({
      entryPoints: [resolve("src/companion/app-control.ts")],
      platform: "node",
      target: "node24",
      format: "esm",
      bundle: true,
      write: false,
    });
    // Invalid argv reaches command validation before loading app data or tools.
    // Keep the entire real dependency graph: a config mock hides import cycles.
    const child = spawnSync(process.execPath, ["--input-type=module"], {
      input: result.outputFiles[0]!.text,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toMatchObject({
      protocol_version: 1,
      type: "error",
      error_code: "INVALID_APP_COMMAND",
    });
  });
});
