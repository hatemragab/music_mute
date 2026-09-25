import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  PersistentRestartBudget,
  resetRestartBudget,
  RestartCircuitOpenError,
} from "../src/runtime/restart-budget.js";
import { ControlPlaneError } from "../src/runtime/control-plane-client.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "restart-budget-"));
  roots.push(root);
  return join(root, "budget.json");
}
it("charges interrupted startups across fresh instances and requires explicit reset after exhaustion", async () => {
  const path = await fixture();
  let now = 1_000_000;
  const next = () =>
    new PersistentRestartBudget(
      path,
      () => now,
      () => 0.5,
    );
  const signal = new AbortController().signal;
  for (let attempt = 0; attempt < 5; attempt++) {
    await next().admit(signal);
    // No failure callback: represents process death after admission was persisted.
    now += 1_000_000;
  }
  await expect(next().admit(signal)).rejects.toBeInstanceOf(
    RestartCircuitOpenError,
  );
  await resetRestartBudget(path);
  await expect(next().admit(signal)).resolves.toBeUndefined();
});
it("quarantines permanent failures but permits bounded transient recovery", async () => {
  const path = await fixture();
  const budget = new PersistentRestartBudget(
    path,
    () => 1_000_000,
    () => 0,
  );
  await budget.admit(new AbortController().signal);
  await budget.recordFailure(
    new ControlPlaneError("WORKER_FORBIDDEN", 403, false),
  );
  await expect(
    new PersistentRestartBudget(path).admit(new AbortController().signal),
  ).rejects.toBeInstanceOf(RestartCircuitOpenError);
  await resetRestartBudget(path);
  const retry = new PersistentRestartBudget(
    path,
    () => 2_000_000,
    () => 0,
  );
  await retry.admit(new AbortController().signal);
  await retry.recordFailure(
    new ControlPlaneError("WORKER_DEPENDENCY_UNAVAILABLE", 503, true),
  );
  await expect(
    new PersistentRestartBudget(path, () => 3_000_000).admit(
      new AbortController().signal,
    ),
  ).resolves.toBeUndefined();
});
it("resets after successful work and orderly stops, and persists bounded jittered backoff", async () => {
  const path = await fixture();
  const budget = new PersistentRestartBudget(
    path,
    () => 100_000,
    () => 0.5,
  );
  await budget.admit(new AbortController().signal);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    starts: 1,
    nextStartAt: 103750,
  });
  await budget.recordSuccess();
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    starts: 1,
    nextStartAt: 0,
  });
  await budget.orderlyStop();
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ starts: 0 });
});
it("does not consume another start when interrupted during backoff", async () => {
  const path = await fixture();
  const first = new PersistentRestartBudget(path, () => 100_000);
  await first.admit(new AbortController().signal);
  const abort = new AbortController();
  const waiting = new PersistentRestartBudget(path, () => 100_000).admit(
    abort.signal,
  );
  setTimeout(() => abort.abort(), 10);
  await expect(waiting).rejects.toThrow();
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ starts: 1 });
});
it("rejects corrupted persistent state rather than resetting the crash budget", async () => {
  const path = await fixture();
  await writeFile(path, "{}", { mode: 0o600 });
  await expect(
    new PersistentRestartBudget(path).admit(new AbortController().signal),
  ).rejects.toThrow("invalid");
});
