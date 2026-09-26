import { fromWire, toWire } from "./wire";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    readonly retryAfter?: number,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  origin: string;
  token: (refresh: boolean) => Promise<string>;
  installationId: () => string;
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    refreshed = false,
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new TypeError("API path must be root-relative.");
    const token = await this.options.token(refreshed);
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "X-Installation-Id": this.options.installationId(),
    });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(`${this.options.origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(toWire(body)),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal,
    });
    if (response.status === 401 && method === "GET" && !refreshed) {
      return this.request<T>(method, path, body, signal, true);
    }
    if (!response.ok) {
      const problem = (await response.json().catch(() => ({}))) as {
        code?: string;
        request_id?: string;
      };
      const retryValue = response.headers.get("Retry-After");
      const retryAfter =
        retryValue && /^\d+$/.test(retryValue) ? Number(retryValue) : undefined;
      throw new ApiError(
        response.status,
        problem.code ?? "REQUEST_FAILED",
        problem.request_id,
        retryAfter,
      );
    }
    if (response.status === 204) return undefined as T;
    return fromWire(await response.json()) as T;
  }

  get<T>(path: string, signal?: AbortSignal) {
    return this.request<T>("GET", path, undefined, signal);
  }
  post<T>(path: string, body: unknown, signal?: AbortSignal) {
    return this.request<T>("POST", path, body, signal);
  }
  put<T>(path: string, body: unknown, signal?: AbortSignal) {
    return this.request<T>("PUT", path, body, signal);
  }
  patch<T>(path: string, body: unknown, signal?: AbortSignal) {
    return this.request<T>("PATCH", path, body, signal);
  }
  delete<T>(path: string, signal?: AbortSignal) {
    return this.request<T>("DELETE", path, undefined, signal);
  }
}
