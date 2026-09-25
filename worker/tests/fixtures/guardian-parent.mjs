import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
const [guardianPath, enginePath, mode] = process.argv.slice(2);
const guardian = spawn(
  process.execPath,
  [
    guardianPath,
    process.execPath,
    enginePath,
    "--spawn-descendant",
    "--busy",
    "--incarnation",
    randomUUID(),
  ],
  {
    detached: true,
    stdio: ["pipe", "pipe", "ignore", "ipc"],
  },
);
let buffer = Buffer.alloc(0);
guardian.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32BE(0)) return;
  const message = JSON.parse(
    buffer.subarray(4, 4 + buffer.readUInt32BE(0)).toString(),
  );
  if (mode === "saturated") guardian.stdin.write(Buffer.alloc(8 * 1024 * 1024));
  process.stdout.write(
    JSON.stringify({
      guardianPid: guardian.pid,
      enginePid: message.payload.enginePid,
      descendantPid: message.payload.descendantPid,
    }) + "\n",
  );
});
setInterval(() => {}, 1000);
