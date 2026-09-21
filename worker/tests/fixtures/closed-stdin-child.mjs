import { randomUUID } from "node:crypto";
import { closeSync } from "node:fs";

const index = process.argv.indexOf("--incarnation");
const incarnation = process.argv[index + 1];
const body = Buffer.from(
  JSON.stringify({
    protocolVersion: 1,
    type: "ready",
    requestId: randomUUID(),
    incarnation,
    sentAt: new Date().toISOString(),
    payload: { processCapacity: 1 },
  }),
);
const frame = Buffer.alloc(4 + body.length);
frame.writeUInt32BE(body.length, 0);
body.copy(frame, 4);
process.stdout.write(frame, () => closeSync(0));
setInterval(() => undefined, 1_000);
