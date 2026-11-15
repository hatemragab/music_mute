import {
  AccountApiClient,
  DesktopApiError,
  type AccountScope,
} from "../../../../chrome-extension/src/companion/account-api.js";
import type { AccountSessionScope } from "../account/account-controller.js";
import type { AccountFetch } from "../account/transport.js";
/** Existing exact-body/no-POST-retry transport, with trusted authorization and strict route allowlist. */
export function createCloudApi(options: {
  origin: string;
  installationId: string;
  account: {
    authorization(force?: boolean): Promise<string>;
    assertScope(scope: AccountSessionScope): void;
  };
  scope: AccountSessionScope;
  fetch?: AccountFetch;
  beforeIntake?(): void;
}) {
  const scope = { ...options.scope };
  const current = () => {
    try {
      options.account.assertScope(scope);
      return true;
    } catch {
      return false;
    }
  };
  const api = new AccountApiClient(
    options.origin,
    async () => {
      options.account.assertScope(scope);
      const token = await options.account.authorization();
      options.account.assertScope(scope);
      return {
        firebase_uid: scope.firebaseUid,
        session_generation: scope.generation,
        id_token: token,
        installation_id: options.installationId,
      };
    },
    current,
    (input, init) => {
      const url = new URL(String(input));
      if (["/jobs", "/media-imports"].includes(url.pathname))
        options.beforeIntake?.();
      return (options.fetch ?? ((url, body) => fetch(url, body)))(
        String(input),
        init ?? {},
      );
    },
  );
  const routes =
    /^\/(?:media-imports(?:\/cache-deliveries)?|jobs|jobs\/[a-f0-9]{24}\/(?:upload-completions|download-grants|cancellations))$/u;
  return {
    origin: api.origin,
    assertCurrent: (candidate: AccountScope) => api.assertCurrent(candidate),
    request: async (
      candidate: AccountScope,
      path: string,
      method: "GET" | "POST" | "PATCH" | "DELETE",
      body?: unknown,
      signal?: AbortSignal,
    ) => {
      if (method !== "POST" || !routes.test(path))
        throw new DesktopApiError("INVALID_API_PATH");
      return await api.request(candidate, path, method, body, signal);
    },
  };
}
