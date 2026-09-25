import { writeFile } from "node:fs/promises";
const { withDarwinFileLock } = await import(process.argv[2]);
await withDarwinFileLock(process.argv[3] + ".guard", async () => {
  await writeFile(
    process.argv[3],
    JSON.stringify({ schemaVersion: 1, pid: process.pid }),
    { mode: 0o600 },
  );
  process.send({ ready: true });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
