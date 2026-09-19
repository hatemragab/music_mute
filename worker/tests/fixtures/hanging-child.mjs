import { randomUUID } from "node:crypto";

const index = process.argv.indexOf("--incarnation");
const incarnation = process.argv[index + 1];
const body = Buffer.from(
  JSON.stringify({
    protocolVersion: 1,
    type: "ready",
    requestId: randomUUID(),
    incarnation,
    sentAt: new Date().toISOString(),
    payload: { processCapacity: 1, path: process.env.PATH },
  }),
);
const frame = Buffer.alloc(4 + body.length);
frame.writeUInt32BE(body.length, 0);
body.copy(frame, 4);
process.stdout.write(frame);
process.stderr.write(
  "token=fixture-secret /Users/hatem/fixture https://storage.invalid/object?X-Amz-Signature=fixture\n",
);
process.stdin.resume();
