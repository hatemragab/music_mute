import { QueryClient } from "@tanstack/react-query";

import { ApiError } from "@/api/api-client";

const shouldRetry = (failureCount: number, error: unknown) => {
  if (failureCount >= 2) return false;
  if (!(error instanceof ApiError)) return failureCount < 1;
  return ![400, 401, 403, 404, 409, 410, 413, 422].includes(error.status);
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetry,
      retryDelay: (attempt, error) =>
        error instanceof ApiError && error.retryAfterSeconds !== undefined
          ? error.retryAfterSeconds * 1000
          : Math.min(1000 * 2 ** attempt, 10_000),
      staleTime: 10_000,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});
