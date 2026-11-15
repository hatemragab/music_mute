import { runIndependentLoginWorker } from "../main/session/login-worker-runtime.js";

const lifetime = new AbortController();
process.once("SIGTERM", () => lifetime.abort());
process.once("SIGINT", () => lifetime.abort());
void runIndependentLoginWorker(lifetime.signal)
  .then((result) => {
    if (result.outcome === "blocked") process.exitCode = 2;
  })
  .catch(() => {
    process.exitCode = 2;
  });
