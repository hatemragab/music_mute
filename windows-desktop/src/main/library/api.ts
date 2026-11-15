import {
  AccountApiClient,
  accountApiOrigin,
  type AccountScope,
} from "../../../../chrome-extension/src/companion/account-api.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import type { AccountFetch } from "../account/transport.js";
export function createLibraryAccountApi(options: {
  origin: string;
  installationId: string;
  account: {
    authorization(force?: boolean): Promise<string>;
    assertScope(scope: SessionAccountScope): void;
  };
  fetch?: AccountFetch;
}) {
  const origin = accountApiOrigin(options.origin);
  return async (
    scope: SessionAccountScope,
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (!(
      (method === "POST" &&
        /^\/jobs\/[a-f0-9]{24}\/download-grants$/u.test(path)) ||
      ((method === "PATCH" || method === "DELETE") &&
        /^\/jobs\/[a-f0-9]{24}$/u.test(path))
    ))
      throw new Error("INVALID_API_PATH");
    options.account.assertScope(scope);
    const api = new AccountApiClient(
      origin,
      async () => {
        options.account.assertScope(scope);
        const id_token = await options.account.authorization();
        options.account.assertScope(scope);
        return {
          firebase_uid: scope.firebaseUid,
          session_generation: scope.generation,
          id_token,
          installation_id: options.installationId,
        };
      },
      () => {
        try {
          options.account.assertScope(scope);
          return true;
        } catch {
          return false;
        }
      },
      (input, init) =>
        (options.fetch ?? ((url, body) => fetch(url, body)))(
          String(input),
          init ?? {},
        ),
    );
    const wire: AccountScope = {
      firebase_uid: scope.firebaseUid,
      session_generation: scope.generation,
    };
    return api.request(wire, path, method, body, signal);
  };
}
