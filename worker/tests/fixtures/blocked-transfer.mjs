import { writeFileSync } from "node:fs";
import { join } from "node:path";
process.once("message", ({ workspace }) => {
  writeFileSync(
    join(workspace, "transfer-owner.json"),
    JSON.stringify({ schemaVersion: 1, pid: process.pid }),
    { mode: 0o600 },
  );
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
