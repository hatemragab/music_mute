import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportMacQualificationReport,
  macosCommandErrorSummary,
} from "../src/platform/macos/cli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

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

  it.skipIf(process.platform === "win32")(
    "exports qualification evidence once into a protected bootstrap root",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "musicmute-macos-cli-"));
      roots.push(root);
      const sourceRoot = join(root, "service-state");
      const outputRoot = join(root, "bootstrap");
      await mkdir(sourceRoot, { mode: 0o700 });
      await mkdir(outputRoot, { mode: 0o700 });
      await chmod(sourceRoot, 0o700);
      await chmod(outputRoot, 0o700);
      const source = join(sourceRoot, "qualification.json");
      const destination = join(outputRoot, "qualification.json");
      await writeFile(source, '{"status":"PASS"}\n', { mode: 0o600 });
      await chmod(source, 0o600);

      await expect(
        exportMacQualificationReport(source, destination),
      ).resolves.toBe(destination);
      await expect(readFile(destination, "utf8")).resolves.toBe(
        '{"status":"PASS"}\n',
      );
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
      await expect(
        exportMacQualificationReport(source, destination),
      ).rejects.toThrow();
    },
  );
});
