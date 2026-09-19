import { fileURLToPath } from "node:url";

import {
  IsolatedServices,
  until,
} from "../../../backend/test/helpers/isolated-services.mjs";

const backendDirectory = fileURLToPath(
  new URL("../../../backend/", import.meta.url),
);
const runtimePath = fileURLToPath(
  new URL(
    "../../../backend/test/helpers/dashboard-runtime.mjs",
    import.meta.url,
  ),
);

process.chdir(backendDirectory);

const services = await IsolatedServices.create();
let stopping = false;

const stop = async () => {
  if (stopping) return;
  stopping = true;
  await services.stop();
};

process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));

try {
  const databases = await services.startDatabases({ replicaSet: true });
  const runtime = services.spawn(
    process.execPath,
    [runtimePath],
    {
      MONGODB_URI: databases.mongoUri,
      REDIS_URL: `redis://127.0.0.1:${databases.redisPort}`,
      CORS_ORIGINS: "http://127.0.0.1:4173",
      AUDIO_PROCESSING_ENABLED: "true",
      APP_UPDATES_ENABLED: "true",
      APK_EXPECTED_PACKAGE_ID: "com.example.fixture",
      RELEASE_LANDING_BASE_URL: "https://example.invalid/api/v1",
      RATE_LIMIT: "10000",
      ADMIN_SENSITIVE_OPERATIONS_PER_MINUTE: "100",
      DASHBOARD_SERVE_FOR_BROWSER: "1",
      DASHBOARD_SERVE_PORT:
        process.env.DASHBOARD_E2E_API_PORT?.trim() || "3100",
    },
    services.directory,
  );
  await until(
    () => {
      if (runtime.failure) throw runtime.failure;
      if (runtime.exitCode !== null || runtime.signalCode !== null)
        throw new Error(
          `Dashboard backend exited during startup:\n${runtime.output}`,
        );
      return runtime.output.includes("DASHBOARD_BROWSER_READY");
    },
    "compiled dashboard backend browser fixture",
    60000,
  );
  console.log("ISOLATED_DASHBOARD_BACKEND_READY");
} catch (error) {
  await stop();
  throw error;
}

await new Promise(() => undefined);
