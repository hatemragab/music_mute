import { loadLocalConfig, inspectLocalReadiness } from "./config.js";
import { Diagnostics } from "./diagnostics.js";
import { resolveDiagnosticIdentity } from "./diagnostic-identity.js";
import { VERSION, MVP_MAX_DURATION_SECONDS } from "../shared/protocol.js";
import { runCommunityPublisher } from "./community-publisher.js";
const config = await loadLocalConfig();
const identity = resolveDiagnosticIdentity(config);
const diagnostics = new Diagnostics(config.logs_root, {
  readOnly: true,
  identity,
});
const command = process.argv[2];
try {
  if (command === "publish-youtube") {
    process.umask(0o077);
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort());
    process.once("SIGINT", () => controller.abort());
    await runCommunityPublisher(config, { signal: controller.signal });
  } else if (command === "doctor") {
    await inspectLocalReadiness(config);
    process.stdout.write(
      JSON.stringify(
        {
          ready: true,
          version: VERSION,
          platform: process.platform,
          arch: process.arch,
          provider: "mps",
          trim_enabled: false,
          max_duration_seconds: MVP_MAX_DURATION_SECONDS,
          diagnostic_mode: "LOCAL_ONLY",
          distribution: "DEVELOPMENT_RUNTIME_REUSE",
        },
        null,
        2,
      ) + "\n",
    );
  } else if (command === "diagnostics") {
    const exported = await diagnostics.export();
    process.stdout.write(
      JSON.stringify(
        { path: exported.path, report: diagnostics.snapshot() },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stderr.write(
      "Usage: node dist/companion/cli.js doctor|diagnostics|publish-youtube\n",
    );
    process.exitCode = 2;
  }
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "DIAGNOSTIC_COMMAND_FAILED";
  process.stderr.write(
    JSON.stringify({ ready: false, error_code: code }) + "\n",
  );
  process.exitCode = 1;
} finally {
  diagnostics.close();
}
