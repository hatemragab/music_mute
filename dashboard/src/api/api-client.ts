import type { OperationReceipt } from "./contracts";
import { fromWireCase, toWireCase, toWireUrl } from "./wire-case";

export interface ApiErrorBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  code?: string;
  request_id?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;

  constructor(options: {
    status: number;
    code?: string;
    message?: string;
    requestId?: string;
    retryAfterSeconds?: number;
  }) {
    super(options.message || "The request could not be completed.");
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code || "REQUEST_FAILED";
    this.requestId = options.requestId;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class OperationOutcomeUnknownError extends Error {
  readonly operationId: string;

  constructor(operationId: string, message: string, cause?: unknown) {
    super(`${message} Operation ID: ${operationId}`, { cause });
    this.name = "OperationOutcomeUnknownError";
    this.operationId = operationId;
  }
}

export interface ApiClientOptions {
  origin: string;
  getToken: (forceRefresh?: boolean) => Promise<string>;
}

export interface RequestOptions extends Omit<RequestInit, "body" | "method"> {
  body?: unknown;
  responseType?: "json" | "text" | "blob";
}

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

const parseRetryAfter = (value: string | null) => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isNaN(date)
    ? undefined
    : Math.max(0, (date - Date.now()) / 1000);
};

const validateOrigin = (value: string) => {
  const url = new URL(value);
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error(
      "The API origin must use HTTPS unless it is a loopback address.",
    );
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "The API origin must not include credentials, a path, query, or fragment.",
    );
  }
  return url.origin;
};

export class ApiClient {
  private readonly origin: string;
  private readonly getToken: ApiClientOptions["getToken"];

  constructor(options: ApiClientOptions) {
    this.origin = validateOrigin(options.origin);
    this.getToken = options.getToken;
  }

  get<T>(path: string, options?: Omit<RequestOptions, "body">) {
    return this.request<T>("GET", path, options);
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>("POST", path, { ...options, body });
  }

  patch<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>("PATCH", path, { ...options, body });
  }

  put<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>("PUT", path, { ...options, body });
  }

  delete<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>("DELETE", path, { ...options, body });
  }

  async download(
    path: string,
    signal?: AbortSignal,
    didRefresh = false,
  ): Promise<{ blob: Blob; filename: string | null; contentType: string }> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error("API paths must be root-relative.");
    }
    const token = await this.getToken(didRefresh);
    const response = await fetch(toWireUrl(`${this.origin}${path}`), {
      method: "GET",
      headers: { accept: "text/csv", authorization: `Bearer ${token}` },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal,
    });
    if (response.status === 401 && !didRefresh) {
      return this.download(path, signal, true);
    }
    if (!response.ok) await this.throwApiError(response);
    const disposition = response.headers.get("content-disposition") ?? "";
    const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    const decoded = match?.[1] ? decodeURIComponent(match[1]) : null;
    const filename = decoded?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? null;
    return {
      blob: await response.blob(),
      filename,
      contentType: response.headers.get("content-type") || "text/csv",
    };
  }

  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
    didRefresh = false,
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error("API paths must be root-relative.");
    }
    const token = await this.getToken(didRefresh);
    const headers = new Headers(options.headers);
    headers.set(
      "accept",
      options.responseType === "blob" ? "*/*" : "application/json",
    );
    headers.set("authorization", `Bearer ${token}`);
    if (options.body !== undefined)
      headers.set("content-type", "application/json");

    const response = await fetch(toWireUrl(`${this.origin}${path}`), {
      ...options,
      method,
      body:
        options.body === undefined
          ? undefined
          : JSON.stringify(toWireCase(options.body)),
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });

    if (response.status === 401 && safeMethods.has(method) && !didRefresh) {
      return this.request<T>(method, path, options, true);
    }

    if (!response.ok) await this.throwApiError(response);

    if (options.responseType === "text") return (await response.text()) as T;
    if (options.responseType === "blob") return (await response.blob()) as T;
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text.trim()) return null as T;
    return fromWireCase(JSON.parse(text)) as T;
  }

  private async throwApiError(response: Response): Promise<never> {
    let body: ApiErrorBody | null = null;
    try {
      if (
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() === "application/problem+json"
      ) {
        const parsed: unknown = await response.json();
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          (parsed as ApiErrorBody).type === "about:blank" &&
          (parsed as ApiErrorBody).status === response.status
        ) {
          body = parsed as ApiErrorBody;
        }
      }
    } catch {
      // The HTTP status and Retry-After remain usable if the body is invalid.
    }
    throw new ApiError({
      status: response.status,
      code:
        typeof body?.code === "string" &&
        /^[A-Z][A-Z0-9_]{1,79}$/.test(body.code)
          ? body.code
          : undefined,
      message: typeof body?.detail === "string" ? body.detail : undefined,
      requestId:
        typeof body?.request_id === "string" ? body.request_id : undefined,
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
    });
  }
}

export const createOperationId = () => crypto.randomUUID();

const isAmbiguousWriteFailure = (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof DOMException && error.name === "AbortError") ||
  (error instanceof ApiError && error.status >= 500);

export async function submitWithReceiptReadBack<T>(options: {
  client: ApiClient;
  operationId: string;
  submit(): Promise<T>;
  readResult(receipt: OperationReceipt): Promise<T>;
}): Promise<T> {
  try {
    return await options.submit();
  } catch (error) {
    if (!isAmbiguousWriteFailure(error)) throw error;

    let receipt: OperationReceipt;
    try {
      receipt = await options.client.get<OperationReceipt>(
        `/admin/operations/${encodeURIComponent(options.operationId)}`,
      );
    } catch (readBackError) {
      throw new OperationOutcomeUnknownError(
        options.operationId,
        "The server response was lost and the operation receipt could not be read. Refresh before trying again.",
        readBackError,
      );
    }

    if (receipt.status === "succeeded") {
      try {
        return await options.readResult(receipt);
      } catch (readBackError) {
        throw new OperationOutcomeUnknownError(
          options.operationId,
          "The operation succeeded, but the updated resource could not be loaded. Refresh to read the committed state.",
          readBackError,
        );
      }
    }
    if (receipt.status === "failed") {
      throw new ApiError({
        status: 409,
        code: receipt.code ?? "OPERATION_FAILED",
        message: `The operation failed. Operation ID: ${options.operationId}`,
      });
    }
    throw new OperationOutcomeUnknownError(
      options.operationId,
      "The operation is still pending. Wait and refresh before trying again.",
      error,
    );
  }
}
