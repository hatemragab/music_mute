import { join } from "node:path";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import { readPackagedResource } from "../browser/package-trust.js";
import { UserRealtimeController } from "../realtime/user-realtime.js";
import {
  AccountUsageController,
  type UsageCachePort,
} from "./account-usage.js";
import type { AccountFetch } from "../account/transport.js";
/** Approved existing public config, requiring only its backend origin for guest policy. */
export function parseGuestPolicyOrigin(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("CONFIGURATION_REQUIRED");
  const row = value as Record<string, unknown>,
    descriptors = Object.getOwnPropertyDescriptors(row);
  if (
    Reflect.ownKeys(row).some(
      (k) =>
        typeof k !== "string" ||
        ![
          "backend_base_url",
          "firebase_api_key",
          "firebase_project_id",
          "google_desktop_client_id",
        ].includes(k),
    ) ||
    Object.values(descriptors).some((d) => !("value" in d)) ||
    typeof row.backend_base_url !== "string" ||
    row.backend_base_url.length > 2048
  )
    throw new Error("CONFIGURATION_REQUIRED");
  try {
    const url = new URL(row.backend_base_url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["/", ""].includes(url.pathname)
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error("CONFIGURATION_REQUIRED");
  }
}
export async function loadGuestPolicyOrigin(
  resourcesPath: string,
): Promise<string> {
  return parseGuestPolicyOrigin(
    parseStrictJson(
      (
        await readPackagedResource(
          join(resourcesPath, "desktop-public-config.json"),
          4096,
        )
      ).toString("utf8"),
      4096,
    ),
  );
}
/** Reuse explicit public checkout/cache without Firebase, a bearer or any guest socket. */
export function createGuestPolicy(options: {
  origin: string;
  installationId: string;
  cache?: UsageCachePort;
  fetch?: AccountFetch;
}) {
  const realtime = new UserRealtimeController({
      origin: parseGuestPolicyOrigin({ backend_base_url: options.origin }),
      installationId: options.installationId,
      account: {
        sessionScope: () => null,
        assertScope: () => {
          throw new Error("SIGN_IN_REQUIRED");
        },
        authorization: async () => {
          throw new Error("SIGN_IN_REQUIRED");
        },
      },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    usage = new AccountUsageController({
      realtime,
      ...(options.cache ? { cache: options.cache } : {}),
    });
  return {
    realtime,
    usage,
    onAppOpen: () => usage.onAppOpen(),
    dispose: () => {
      usage.dispose();
      realtime.dispose();
    },
  };
}
