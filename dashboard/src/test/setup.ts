import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";

import { dashboardServer } from "./server";

beforeAll(() => dashboardServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  dashboardServer.resetHandlers();
});
afterAll(() => dashboardServer.close());

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

Object.defineProperties(HTMLMediaElement.prototype, {
  pause: { configurable: true, value: vi.fn() },
  load: { configurable: true, value: vi.fn() },
});

Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
  configurable: true,
  value: () => false,
});

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: () => undefined,
});
