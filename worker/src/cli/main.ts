#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerChildProcess } from "../agent/child-process.js";

const command = process.argv[2];

if (command !== "protocol-doctor") {
  console.error("Usage: musicmute-worker protocol-doctor");
  process.exitCode = 2;
} else {
  const workerRoot = resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
  );
  const child = new WorkerChildProcess({
    command: process.platform === "win32" ? "python" : "python3",
    args: ["-m", "musicmute_engine.child"],
    cwd: resolve(workerRoot, "engine"),
  });
  try {
    await child.start();
    const result = await child.request("ping", {});
    if (result.payload.status !== "ok")
      throw new Error("Protocol check failed");
    console.log("MusicMute worker child protocol: OK");
  } catch {
    console.error("MusicMute worker child protocol: FAILED");
    process.exitCode = 1;
  } finally {
    await child.stop();
  }
}
