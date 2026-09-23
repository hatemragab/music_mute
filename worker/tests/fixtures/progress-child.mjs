import { randomUUID } from "node:crypto";

const incarnation = process.argv[process.argv.indexOf("--incarnation") + 1];
let pending = Buffer.alloc(0);

function send(type, requestId, payload) {
  const body = Buffer.from(
    JSON.stringify({
      protocolVersion: 1,
      type,
      requestId,
      incarnation,
      sentAt: new Date().toISOString(),
      payload,
    }),
  );
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  process.stdout.write(frame);
}

send("startup-progress", randomUUID(), { stage: "loading" });
send("startup-progress", randomUUID(), { stage: "warming" });
send("startup-progress", randomUUID(), { stage: "imaginary" });
send("ready", randomUUID(), { processCapacity: 1 });

process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const length = pending.readUInt32BE(0);
    if (pending.length < length + 4) break;
    const message = JSON.parse(
      pending.subarray(4, length + 4).toString("utf8"),
    );
    pending = pending.subarray(length + 4);
    if (message.command === "process") {
      send("accepted", message.requestId, { accepted: true });
      send("progress", message.requestId, { stage: "input-validation" });
      send("progress", message.requestId, { stage: "separation" });
      send("progress", message.requestId, {
        stage: "separation",
        unit: "windows",
        completed: 1,
        total: 4,
      });
      send("progress", message.requestId, {
        stage: "separation",
        unit: "windows",
        completed: 1,
        total: 4,
      });
      send("progress", message.requestId, { stage: "preparation" });
      send("progress", randomUUID(), { stage: "encoding" });
      send("progress", message.requestId, {
        stage: "separation",
        fraction: 0.75,
      });
      send("progress", message.requestId, {
        stage: "separation",
        unit: "windows",
        completed: 4,
        total: 4,
      });
      send("progress", message.requestId, { stage: "output-ready" });
      send("result", message.requestId, { status: "ok" });
    } else if (message.command === "shutdown") {
      send("result", message.requestId, { stopped: true });
      process.exitCode = 0;
      process.stdin.pause();
    }
  }
});
