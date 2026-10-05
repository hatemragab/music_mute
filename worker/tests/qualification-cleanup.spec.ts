import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupQualificationWorkspace } from "../src/enrollment/qualification-cleanup.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("confirmed qualification workspace cleanup", () => {
  it.each([false, true])(
    "removes confirmed generated media and preserves reports (legacy=%s)",
    async (legacy) => {
      const root = await fixtureRoot();
      const workRoot = join(root, "attempts");
      const workspace = join(workRoot, `qualification-${randomUUID()}`);
      const outputPath = legacy
        ? join(workspace, randomUUID(), "output", "vocals.mp3")
        : join(workspace, "vocals.mp3");
      await mkdir(join(outputPath, ".."), { recursive: true });
      await writeFile(outputPath, "confirmed output");
      await writeFile(join(workspace, "fixture.wav"), "temporary fixture");
      const report = join(root, "qualification.json");
      await writeFile(report, "sanitized evidence");

      await expect(
        cleanupQualificationWorkspace({ workRoot, outputPath }),
      ).resolves.toBe(true);
      await expect(lstat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(report, "utf8")).resolves.toBe(
        "sanitized evidence",
      );
      await expect(
        cleanupQualificationWorkspace({ workRoot, outputPath }),
      ).resolves.toBe(false);
    },
  );

  it("preserves operator audio and production attempt workspaces", async () => {
    const workRoot = await fixtureRoot();
    for (const outputPath of [
      join(workRoot, "saved-audio", "vocals.mp3"),
      join(workRoot, randomUUID(), "output", "vocals.mp3"),
      join(workRoot, "..", "operator-output.mp3"),
    ]) {
      await mkdir(join(outputPath, ".."), { recursive: true });
      await writeFile(outputPath, "preserved");
      await expect(
        cleanupQualificationWorkspace({ workRoot, outputPath }),
      ).resolves.toBe(false);
      await expect(readFile(outputPath, "utf8")).resolves.toBe("preserved");
      await rm(outputPath);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects linked qualification entries without touching their target",
    async () => {
      const root = await fixtureRoot();
      const workRoot = join(root, "attempts");
      const workspace = join(workRoot, `qualification-${randomUUID()}`);
      await mkdir(workspace, { recursive: true });
      const target = join(root, "operator-audio.mp3");
      await writeFile(target, "preserved");
      const outputPath = join(workspace, "vocals.mp3");
      await symlink(target, outputPath);

      await expect(
        cleanupQualificationWorkspace({ workRoot, outputPath }),
      ).rejects.toThrow("unsafe entry");
      await expect(readFile(target, "utf8")).resolves.toBe("preserved");
    },
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), "musicmute-qualification-cleanup-"),
  );
  roots.push(root);
  return root;
}
