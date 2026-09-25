/** Standalone guardian: no engine imports, model state, or backend credentials.
 * The parent's pipe lifetime is independent of synchronous/native inference.
 * All POSIX descendants share this guardian's private process group.
 */
import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command || process.platform === "win32") process.exit(2);
// Refuse to signal an inherited group; the supervisor must start us detached.
// Node has no getpgrp(), but a negative own PID can only target our private group.
const engineEnvironment = { ...process.env };
delete engineEnvironment.NODE_CHANNEL_FD;
delete engineEnvironment.NODE_CHANNEL_SERIALIZATION_MODE;
const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: engineEnvironment,
  windowsHide: true,
  detached: false,
});
let terminating = false;
function terminate(): void {
  if (terminating) return;
  terminating = true;
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
    process.exit(2);
  }
}
// The IPC channel observes parent death even if engine stdin is backpressured.
process.on("disconnect", terminate);
process.stdin.on("end", terminate);
process.stdin.on("error", terminate);
process.stdout.on("error", terminate);
process.stderr.on("error", terminate);
child.stdin.on("error", terminate);
child.on("error", terminate);
child.on("exit", terminate);
process.on("SIGTERM", terminate);
process.on("SIGINT", terminate);
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
