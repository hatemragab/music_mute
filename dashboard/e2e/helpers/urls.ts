export const E2E_APP_ORIGIN = "http://127.0.0.1:4173";
export const E2E_BACKEND_PORT =
  process.env.DASHBOARD_E2E_API_PORT?.trim() || "3100";
export const E2E_BACKEND_ORIGIN = `http://127.0.0.1:${E2E_BACKEND_PORT}`;
export const E2E_API_ORIGIN = `${E2E_BACKEND_ORIGIN}/api/v1`;
