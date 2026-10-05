import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("macOS package build contract", () => {
  it("emits the model metadata module imported by the packager", async () => {
    const [buildSource, packageSource] = await Promise.all([
      readFile("scripts/build.mjs", "utf8"),
      readFile("scripts/package-macos.mjs", "utf8"),
    ]);

    expect(packageSource).toContain(
      'import { MODEL } from "../dist/companion/app-setup.js";',
    );
    expect(buildSource).toContain('"src/companion/app-setup.ts",');
    expect(packageSource).toContain('scope: "PRE_OUTER_SEAL"');
    expect(packageSource).toContain(
      'measurement_scope = "FINAL_POST_SEAL_INVENTORY"',
    );
    expect(packageSource).toContain(
      'scope: "FINAL_SIGNED_APP", files: inventory',
    );
    expect(packageSource).toContain("final_inventory: finalInventory");
  });

  it("requires the external downloader runtime to reject another uid", async () => {
    const qualificationSource = await readFile(
      "scripts/qualify-packaged-tools.mjs",
      "utf8",
    );

    expect(qualificationSource).toContain(
      "except bootstrap.BootstrapError as error:",
    );
    expect(qualificationSource).toContain(
      'if str(error) != "DOWNLOADER_IDENTITY_INVALID":',
    );
    expect(qualificationSource).toContain(
      '"PACKAGED_BOOTSTRAP_DIFFERING_UID_REJECTED"',
    );
    expect(qualificationSource).not.toContain(
      '"PACKAGED_BOOTSTRAP_DIFFERING_UID_ACCEPTED"',
    );
    expect(qualificationSource).toContain(
      '"Library/Application Support/MusicMuteLocal"',
    );
    expect(qualificationSource).toContain(
      'native_home_verification = "DISPOSABLE_CFFIXED_USER_HOME"',
    );
    expect(qualificationSource).toContain("CFFIXED_USER_HOME: home");
  });
});
