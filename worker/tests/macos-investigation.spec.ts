import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  explainError,
  investigateErrors,
  investigateJob,
} from "../src/platform/macos/investigation.js";
import { createMacUserLayout } from "../src/platform/macos/user-paths.js";

const roots: string[] = [];
const jobId = "507461bf507461bf507461bf";
const first = "a5ad29d1-1ccf-4a90-bc52-87bb17f74442";
const second = "9f0f243b-a9a2-49fd-b01e-5ee8e4006b2e";
const modelIncarnation = "0d7d7a6d-63fa-459e-a093-8a77dc39f530";
const at = (seconds: number) =>
  new Date(Date.UTC(2026, 8, 22, 12, 0, seconds)).toISOString();

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("joins local retries across segments with stage durations and child restart evidence", async () => {
  const layout = await fixture();
  await writeEvents(layout, "events-000000000001.jsonl", [
    event(1, 0, "attempt-started", first, {
      attemptNumber: 1,
      childIncarnation: modelIncarnation,
    }),
    event(2, 1, "attempt-progress", first, { stage: "input-download" }),
    event(3, 3, "attempt-progress", first, {
      stage: "separation",
      work: { unit: "windows", completed: 1, total: 4 },
    }),
    event(4, 5, "child-failed", first, {
      code: "GPU_OOM",
      stage: "separation",
      detail: "GPU provider reported out of memory",
    }),
  ]);
  await writeEvents(layout, "events.jsonl", [
    event(5, 6, "attempt-failed", first, {
      code: "SEPARATOR_FAILED",
      stage: "separation",
    }),
    event(6, 7, "child-restarted", first),
    event(7, 8, "attempt-started", second, { attemptNumber: 2 }),
    event(8, 9, "attempt-progress", second, { stage: "separation" }),
    event(9, 11, "attempt-succeeded", second),
  ]);

  const job = await investigateJob(layout, jobId);
  expect(job).toMatchObject({ foundLocally: true, retryCountObserved: 1 });
  expect(job.attempts.map((attempt) => attempt.state)).toEqual([
    "failed",
    "succeeded",
  ]);
  expect(job.attempts[0]?.childRestarts).toBe(1);
  expect(job.attempts[0]?.modelIncarnation).toBe(modelIncarnation);
  expect(job.attempts[0]?.stages).toMatchObject([
    { name: "input-download", durationMs: 2000 },
    {
      name: "separation",
      durationMs: 3000,
      lastWork: { completed: 1, total: 4 },
    },
  ]);
  expect(job.attempts[0]?.evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "child-failed",
        code: "GPU_OOM",
        sequence: 4,
      }),
    ]),
  );

  const errors = await investigateErrors(layout, Date.parse(at(0)) - 1);
  expect(errors.groups).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "GPU_OOM",
        occurrences: 1,
        affectedJobs: 1,
        recoveryObserved: true,
      }),
    ]),
  );
  const explanation = await explainError(
    layout,
    "GPU_OOM",
    Date.parse(at(0)) - 1,
  );
  expect(explanation).toMatchObject({ observedCountInRetainedHistory: 1 });
});

it("treats absent local evidence and unknown errors conservatively", async () => {
  const layout = await fixture();
  const job = await investigateJob(layout, jobId);
  expect(job).toMatchObject({
    foundLocally: false,
    incompleteHistory: true,
    attempts: [],
  });
  expect(job.warning).toContain("another worker");
  const explanation = await explainError(
    layout,
    "OTHER_CODE",
    Date.parse(at(0)),
  );
  expect(explanation).toMatchObject({
    definition: "No catalogue definition for this code.",
    observedCountInRetainedHistory: 0,
  });
  await expect(
    investigateErrors(layout, Date.parse(at(0)), 101),
  ).rejects.toThrow("limit");
  await expect(investigateJob(layout, "private/path")).rejects.toThrow(
    "Job ID",
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-investigate-"));
  roots.push(root);
  const layout = createMacUserLayout(root);
  await mkdir(join(layout.workRoot, "..", "logs"), {
    recursive: true,
    mode: 0o700,
  });
  return layout;
}

async function writeEvents(
  layout: ReturnType<typeof createMacUserLayout>,
  name: string,
  records: object[],
) {
  await writeFile(
    join(layout.workRoot, "..", "logs", name),
    records.map((item) => JSON.stringify(item)).join("\n") + "\n",
    { mode: 0o600 },
  );
}

function event(
  sequence: number,
  seconds: number,
  kind: string,
  attemptId: string,
  fields: Record<string, unknown> = {},
) {
  return {
    recordedAt: at(seconds),
    event: {
      schemaVersion: 2,
      sequence,
      kind,
      component: "worker-runtime",
      jobId,
      attemptId,
      ...fields,
    },
  };
}
