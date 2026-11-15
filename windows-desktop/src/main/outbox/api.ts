import {
  AccountApiClient,
  DesktopApiError,
  type AccountScope,
} from "../../../../chrome-extension/src/companion/account-api.js";
import type { AccountTransport } from "../../../../chrome-extension/src/companion/account-realtime.js";
import type { AccountSessionScope } from "../account/account-controller.js";
export interface OutboxAccountPort {
  sessionScope(): AccountSessionScope | null;
  assertScope(scope: AccountSessionScope): void;
  authorization(force?: boolean): Promise<string>;
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DesktopApiError("CANCELLED"));
    if (signal.aborted) {
      void operation.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export function outboxAccountScope(scope: AccountSessionScope): AccountScope {
  return {
    firebase_uid: scope.firebaseUid,
    session_generation: scope.generation,
  };
}
export function createOutboxApi(
  origin: string,
  installationId: string,
  account: OutboxAccountPort,
  scope: AccountSessionScope,
  signal: AbortSignal,
  fetcher?: typeof fetch,
): AccountTransport {
  const current = (candidate: AccountScope): boolean => {
    try {
      account.assertScope(scope);
      return (
        !signal.aborted &&
        candidate.firebase_uid === scope.firebaseUid &&
        candidate.session_generation === scope.generation
      );
    } catch {
      return false;
    }
  };
  const api = new AccountApiClient(
    origin,
    async () => {
      account.assertScope(scope);
      signal.throwIfAborted();
      const token = await account.authorization();
      account.assertScope(scope);
      signal.throwIfAborted();
      return {
        ...outboxAccountScope(scope),
        id_token: token,
        installation_id: installationId,
      };
    },
    current,
    fetcher,
  );
  return {
    origin: api.origin,
    assertCurrent: (candidate) => api.assertCurrent(candidate),
    request: async (candidate, path, method, body, requestSignal) => {
      if (
        method !== "POST" ||
        !/^\/(?:local-media-syncs(?:\/[a-f0-9]{24}\/(?:upload-grants|completions))?|media-imports\/cache-deliveries)$/.test(
          path,
        )
      )
        throw new DesktopApiError("INVALID_API_PATH");
      const active = AbortSignal.any([
        signal,
        ...(requestSignal ? [requestSignal] : []),
      ]);
      active.throwIfAborted();
      return bounded(
        api.request(candidate, path, method, body, active),
        active,
      );
    },
  };
}
