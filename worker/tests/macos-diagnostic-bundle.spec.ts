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
  it("exports only the selected job's allowlisted evidence and rejects collisions", async () => {
    const home = await mkdtemp(join(tmpdir(), "musicmute-job-bundle-"));
    roots.push(home);
    await chmod(home, 0o700);
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    const jobId = "507461bf507461bf507461bf";
    const attemptId = "4dbb723a-67de-4813-acd6-616d7f8a7b2c";
    const eventPath = join(layout.workRoot, "..", "logs", "events.jsonl");
    await mkdir(join(layout.workRoot, "..", "logs"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      eventPath,
      [
        {
          recordedAt: new Date().toISOString(),
          event: {
            kind: "attempt-started",
            jobId,
            attemptId,
            attemptNumber: 1,
          },
        },
        {
          recordedAt: new Date().toISOString(),
          event: {
            kind: "attempt-failed",
            jobId,
            attemptId,
            code: "DOWNLOAD_FAILED",
            stage: "input-download",
          },
        },
      ]
        .map((item) => JSON.stringify(item))
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    const outputPath = join(home, "job-diagnostics.zip");
    const execute = vi.fn(
      async (_file: string, arguments_: readonly string[]) => {
        const staging = arguments_[4]!;
        const files = [
          "manifest.json",
          "status.json",
          "doctor.json",
          "job.json",
          "job-performance.json",
          "job-errors.json",
        ];
        const contents = (
          await Promise.all(
            files.map((name) => readFile(join(staging, name), "utf8")),
          )
        ).join("\n");
        expect(contents).toContain(jobId);
        expect(contents).toContain("DOWNLOAD_FAILED");
        expect(contents).not.toContain("secret-token");
        expect(contents).not.toContain("private-song.mp3");
        expect(contents).not.toContain("signedUrl");
        expect(contents).not.toContain("/Users/private");
        await writeFile(arguments_[5]!, "fake zip", { mode: 0o600 });
        return { stdout: "", stderr: "" };
      },
    );
    const options = {
      layout,
      jobId,
      outputPath,
      execute,
      status: {
        healthy: false,
        signedUrl: "secret-token",
        privatePath: "/Users/private/private-song.mp3",
      },
      health: {
        schemaVersion: 1 as const,
        healthy: false,
        checks: [
          {
            name: "runtime-doctor",
            ok: false,
            path: "/Users/private/private-song.mp3",
            code: "RUNTIME_FAILED",
            evidence: "Check failed",
          },
        ],
      },
    };
    const result = await createMacDiagnosticBundle(options);
    expect(result.files).toContain("job.json");
    await expect(createMacDiagnosticBundle(options)).rejects.toThrow(
      "already exists",
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it("removes an oversized export and preserves an existing target", async () => {
    const home = await mkdtemp(join(tmpdir(), "musicmute-size-bundle-"));
    roots.push(home);
    await chmod(home, 0o700);
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    await writeFile(layout.configPath, "{}\n", { mode: 0o600 });
    const outputPath = join(home, "oversized.zip");
    const options = {
      layout,
      outputPath,
      status: { healthy: true },
      health: { schemaVersion: 1 as const, healthy: true, checks: [] },
      execute: async (_file: string, arguments_: readonly string[]) => {
        await writeFile(arguments_[5]!, Buffer.alloc(8 * 1024 * 1024 + 1), {
          mode: 0o600,
        });
        return { stdout: "", stderr: "" };
      },
    };
    await expect(createMacDiagnosticBundle(options)).rejects.toThrow(
      "size limit",
    );
    await expect(readFile(outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(outputPath, "existing", { mode: 0o600 });
    await expect(createMacDiagnosticBundle(options)).rejects.toThrow(
      "already exists",
    );
    expect(await readFile(outputPath, "utf8")).toBe("existing");
  });

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
