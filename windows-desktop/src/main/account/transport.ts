import { AccountError, record } from "./errors.js";
export type AccountFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;
function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  userSignal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        new AccountError(
          userSignal?.aborted ? "CANCELLED" : "NETWORK_UNAVAILABLE",
        ),
      );
    if (signal.aborted) {
      void operation.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
/** Fixed destinations are selected by the controller; never accept renderer URLs. */
export async function accountRequest(
  fetcher: AccountFetch,
  url: string,
  init: RequestInit,
  options: { signal?: AbortSignal; limit?: number; deadlineMs?: number } = {},
): Promise<Record<string, unknown>> {
  const limit = options.limit ?? 1024 * 1024;
  const deadline = AbortSignal.timeout(options.deadlineMs ?? 15000);
  const signal = options.signal
    ? AbortSignal.any([deadline, options.signal])
    : deadline;
  try {
    const response = await abortable(
      fetcher(url, {
        ...init,
        redirect: "error",
        cache: "no-store",
        signal,
      }),
      signal,
      options.signal,
    );
    if (signal.aborted) throw new AccountError("CANCELLED");
    let value: Record<string, unknown> = {};
    if (response.status !== 204) {
      if (
        !/^application\/(?:json|problem\+json)(?:;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        throw new AccountError("MALFORMED_RESPONSE");
      const declared = response.headers.get("content-length");
      if (
        declared !== null &&
        (!/^[0-9]+$/.test(declared) || Number(declared) > limit)
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw new AccountError("MALFORMED_RESPONSE");
      }
      if (!response.body) throw new AccountError("MALFORMED_RESPONSE");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await abortable(reader.read(), signal, options.signal);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > limit) throw new AccountError("MALFORMED_RESPONSE");
          chunks.push(part.value);
        }
      } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
      if (size) {
        try {
          value = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          throw new AccountError("MALFORMED_RESPONSE");
        }
      }
    }
    if (signal.aborted) throw new AccountError("CANCELLED");
    if (!response.ok) {
      const nested =
        typeof value.error === "object" && value.error
          ? record(value.error)
          : {};
      const raw =
        typeof value.code === "string"
          ? value.code
          : typeof nested.message === "string"
            ? nested.message.split(" : ")[0]
            : "ACCOUNT_REQUEST_FAILED";
      const retry = response.headers.get("retry-after");
      throw new AccountError(
        raw ?? "ACCOUNT_REQUEST_FAILED",
        retry && /^[0-9]{1,5}$/.test(retry)
          ? Math.min(Number(retry), 86400)
          : 0,
      );
    }
    return value;
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new AccountError(
      options.signal?.aborted ? "CANCELLED" : "NETWORK_UNAVAILABLE",
    );
  }
}
