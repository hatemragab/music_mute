import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { AuthProvider, useAuth } from "./AuthProvider";
import { StartupScreen } from "./StartupScreen";

const authEvents = vi.hoisted(() => ({
  callback: null as
    | null
    | ((
        user: { uid: string; getIdToken: () => Promise<string> } | null,
      ) => void),
  unsubscribed: 0,
}));
vi.mock("firebase/app", () => ({ initializeApp: () => ({}) }));
vi.mock("firebase/auth", () => ({
  getAuth: () => ({}),
  onAuthStateChanged: (
    _auth: unknown,
    callback: typeof authEvents.callback,
  ) => {
    authEvents.callback = callback;
    return () => {
      authEvents.unsubscribed += 1;
    };
  },
  signOut: vi.fn(),
}));
vi.mock("../config", () => ({
  readConfig: () => ({
    apiOrigin: "https://api.example.com",
    firebase: {
      apiKey: "public-key",
      authDomain: "example.firebaseapp.com",
      projectId: "example",
      appId: "app",
    },
  }),
}));
vi.mock("./installation", () => ({
  installationIdFor: () => "test-installation",
}));

function Phase() {
  const { state } = useAuth();
  return <span data-testid="phase">{state.phase}</span>;
}
function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <AuthProvider>
          <StartupScreen />
          <Phase />
        </AuthProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  authEvents.callback = null;
  authEvents.unsubscribed = 0;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("restoring sign-in times out, offers retry and accepts the next auth result", async () => {
  mount();
  expect(screen.getByRole("status")).toHaveTextContent("Checking your sign-in");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Sign-in is taking longer than expected",
  );
  await act(async () => {
    authEvents.callback?.(null);
  });
  expect(screen.getByTestId("phase")).toHaveTextContent("error");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(screen.getByRole("status")).toHaveTextContent("Checking your sign-in");
  expect(authEvents.unsubscribed).toBe(1);
  await act(async () => {
    authEvents.callback?.(null);
  });
  expect(screen.getByTestId("phase")).toHaveTextContent("signedOut");
});

test("a stalled session request times out and gives a localized retry", async () => {
  let finishRequest: (response: Response) => void = () => {};
  const fetchRequest = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finishRequest = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetchRequest);
  mount();
  await act(async () => {
    authEvents.callback?.({ uid: "user", getIdToken: async () => "token" });
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Connecting to your library",
  );
  expect(fetchRequest).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "The server is taking longer than expected",
  );
  await act(async () => {
    finishRequest(new Response("{}", { status: 200 }));
  });
  expect(screen.getByTestId("phase")).toHaveTextContent("error");
  fireEvent.click(screen.getByRole("button", { name: "العربية" }));
  expect(screen.getByRole("alert")).toHaveTextContent("الخادم");
  fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "التحقق من تسجيل الدخول",
  );
});

test("a completed session opens the app before the timeout", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response('{"account_status":"active"}', { status: 200 }),
    ),
  );
  mount();
  await act(async () => {
    authEvents.callback?.({ uid: "user", getIdToken: async () => "token" });
  });
  expect(screen.getByTestId("phase")).toHaveTextContent("signedIn");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(screen.getByTestId("phase")).toHaveTextContent("signedIn");
});
