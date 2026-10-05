import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

async function source(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

describe("thin-package qualification gates", () => {
  it("stages one package-bound runtime for app relocation and reuses it across both locations", async () => {
    const script = await source("scripts/qualify-app-relocation.mjs");

    expect(script).toContain("stageExternalRuntimeForQualification");
    expect(script).toContain("verifyExternalRuntimeForQualification");
    expect(script).toContain("ONE_DISPOSABLE_RELEASE_FOR_BOTH_APP_LOCATIONS");
    expect(script).toContain("Location A copy contains no embedded runtime");
    expect(script).toContain(
      "Relocated location B contains no embedded runtime",
    );
    expect(script).not.toContain(
      'join(resources, "runtime/runtime/python/bin/python3")',
    );
    expect(script).not.toContain("Applications/MusicMute Local.app");
  });

  it("binds package-mode live smoke and cancellation to generated package artifacts", async () => {
    const [smoke, cancellation] = await Promise.all([
      source("scripts/live-smoke.mjs"),
      source("scripts/qualify-native-cancellation.mjs"),
    ]);

    for (const script of [smoke, cancellation]) {
      expect(script).toContain("stageExternalRuntimeForQualification");
      expect(script).toContain("verifyExternalRuntimeForQualification");
      expect(script).not.toContain(
        'join(resources, "runtime/runtime/python/bin/python3")',
      );
    }
    expect(cancellation).not.toContain(
      'join(homedir(), "Applications/MusicMute Local.app")',
    );
  });

  it("requires explicit canonical runtime roots for standalone tool integration", async () => {
    const [youtube, fileProvider] = await Promise.all([
      source("scripts/qualify-youtube-runtime.mjs"),
      source("tests/file-provider.test.ts"),
    ]);

    for (const script of [youtube, fileProvider]) {
      expect(script).toContain("MUSICMUTE_LOCAL_RUNTIME");
      expect(script).toContain("isAbsolute");
      expect(script).toContain("realpath");
      expect(script).not.toContain(
        "/Applications/MusicMute Local.app/Contents/Resources/runtime",
      );
    }
    expect(youtube).toContain("MUSICMUTE_LOCAL_RUNTIME_REQUIRED");
    expect(fileProvider).toContain(
      "if (setting === undefined) return undefined",
    );
  });
});
