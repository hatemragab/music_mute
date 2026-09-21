import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMacDiagnosticBundle } from "../src/platform/macos/diagnostic-bundle.js";
import {
  createMacUserDirectories,
  createMacUserLayout,
} from "../src/platform/macos/user-paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("macOS diagnostic bundle", () => {
  it("packages only sanitized operational data and config field names", async () => {
    const home = await mkdtemp(join(tmpdir(), "musicmute-bundle-"));
    roots.push(home);
    await chmod(home, 0o700);
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    await mkdir(join(layout.workRoot, "..", "logs"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      layout.configPath,
      JSON.stringify({
        credential: "secret",
        slots: [{ workerId: "private" }],
      }),
      { mode: 0o600 },
    );
    const outputPath = join(home, "diagnostics.zip");
    const execute = vi.fn(
      async (_file: string, arguments_: readonly string[]) => {
        const staging = arguments_[4]!;
        const fields = await readFile(
          join(staging, "config-fields.json"),
          "utf8",
        );
        expect(fields).toContain("credential");
        expect(fields).not.toContain("secret");
        await writeFile(arguments_[5]!, "fake zip", { mode: 0o600 });
        return { stdout: "", stderr: "" };
      },
    );
    const result = await createMacDiagnosticBundle({
      layout,
      status: { healthy: true },
      health: { schemaVersion: 1, healthy: true, checks: [] },
      outputPath,
      execute,
    });
    expect(result.path).toBe(outputPath);
    expect(result.files).toContain("recent-errors.txt");
    expect(execute).toHaveBeenCalledOnce();
  });
});
