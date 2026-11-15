import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { recentRows } from "./probe.mjs";

test("probe polling treats an absent rotating capture as no match and preserves other I/O failures", async (t) => {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "probe-reader-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "events.jsonl");
  assert.deepEqual(await recentRows(file), []);
  const traceId = randomUUID();
  await writeFile(file, JSON.stringify({ traceId }) + "\n", { mode: 0o600 });
  assert.deepEqual(await recentRows(file), [{ traceId }]);
  await assert.rejects(recentRows(directory));
});
