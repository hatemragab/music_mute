import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerRemoteCommand } from "../src/runtime/contracts.js";
import { PackagedRuntimeCommandExecutor } from "../src/runtime/remote-command-executor.js";

const roots: string[] = [];
const commandId = "f684cb4d-cdef-4bbf-8925-d5701fdf20c7";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-remote-command-"));
  roots.push(root);
  const workRoot = join(root, "jobs", "attempts");
  await mkdir(workRoot, { recursive: true });
  await mkdir(join(root, "state"));
  await writeFile(join(root, "state", "qualification.wav"), "fixture");
  const serviceCheck = vi.fn(async () => undefined);
  const runFile = vi.fn(
    async (_command: string, args: string[]): Promise<{ stdout: string }> => {
      if (args.includes("musicmute_engine.service_doctor"))
        return { stdout: JSON.stringify({ status: "ok", modelBytes: 123 }) };
      const reportPath = args[args.indexOf("--report") + 1]!;
      const recipeId = args[args.indexOf("--recipe-id") + 1]!;
      const iterations = Number(args[args.indexOf("--iterations") + 1]);
      await writeFile(
        reportPath,
        JSON.stringify({
          status: "PASS",
          providerDispatch: { proven: true },
          recipes: Array.from({ length: iterations }, (_, index) => ({
            recipeId,
            endToEndSeconds: index + 1,
            resultBytes: 100 + index,
          })),
        }),
      );
      return { stdout: "{}" };
    },
  );
  const executor = new PackagedRuntimeCommandExecutor({
    workRoot,
    modelCacheRoot: join(root, "models"),
    engineRoot: join(root, "runtime", "current", "app", "engine"),
    pythonPath: join(root, "python"),
    ffmpegPath: join(root, "bin", "ffmpeg"),
    ffprobePath: join(root, "bin", "ffprobe"),
    provider: "mps",
    serviceCheck,
    runFile,
  });
  return { executor, runFile, serviceCheck };
}

function command(value: Partial<WorkerRemoteCommand>): WorkerRemoteCommand {
  return {
    commandId,
    kind: "doctor",
    state: "pending",
    checks: ["service"],
    recipeId: null,
    iterations: null,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    summary: null,
    metrics: [],
    completedAt: null,
    revision: 1,
    ...value,
  };
}

describe("packaged remote command executor", () => {
  it("runs requested Doctor checks without privileged operations", async () => {
    const f = await fixture();
    const result = await f.executor.execute(
      command({
        checks: ["service", "storage", "model", "provider", "ffmpeg"],
      }),
    );

    expect(result).toMatchObject({
      outcome: "succeeded",
      summary: "5 worker health checks passed",
    });
    expect(result.metrics.map((metric) => metric.name)).toEqual([
      "check.service",
      "check.storage",
      "storage.free_bytes",
      "check.model",
      "model.bytes",
      "check.provider",
      "check.ffmpeg",
    ]);
    expect(f.serviceCheck).toHaveBeenCalledOnce();
  });

  it("runs exactly one Kim Vocal 2 benchmark pass", async () => {
    const f = await fixture();
    const result = await f.executor.execute(
      command({
        kind: "benchmark",
        checks: [],
        recipeId: "kim-vocals-v2",
        iterations: 1,
      }),
    );

    expect(result).toMatchObject({
      outcome: "succeeded",
      metrics: expect.arrayContaining([
        { name: "benchmark.iterations", value: 1, unit: "count" },
        { name: "benchmark.mean_seconds", value: 1, unit: "seconds" },
      ]),
    });
    expect(f.runFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        "--recipe-id",
        "kim-vocals-v2",
        "--iterations",
        "1",
      ]),
      expect.objectContaining({ timeout: 7_200_000 }),
    );
  });
});
