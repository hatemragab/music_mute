import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { AccountPage } from "./AccountPage";

const mocks = vi.hoisted(() => ({
  reload: vi.fn(),
  retry: vi.fn(),
  logout: vi.fn(),
  api: { get: vi.fn(), post: vi.fn() },
  user: {
    uid: "test-user",
    email: "listener@example.com",
    emailVerified: false,
    providerData: [{ providerId: "password" }],
    getIdToken: vi.fn(),
  },
  session: {
    user: {
      displayName: "Listener",
      email: "listener@example.com",
      emailVerified: false,
    },
  },
}));

vi.mock("../auth/AuthProvider", () => ({
  useSignedIn: () => mocks,
  useAuth: () => ({ retry: mocks.retry, logout: mocks.logout }),
}));
vi.mock("firebase/auth", () => ({
  reload: mocks.reload,
  EmailAuthProvider: { credential: vi.fn() },
  GoogleAuthProvider: vi.fn(),
  linkWithCredential: vi.fn(),
  linkWithPopup: vi.fn(),
  reauthenticateWithCredential: vi.fn(),
  reauthenticateWithPopup: vi.fn(),
  unlink: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  mocks.user.emailVerified = false;
  mocks.session.user.emailVerified = false;
  mocks.api.get.mockResolvedValue({ items: [], nextCursor: null });
  mocks.api.post.mockResolvedValue({});
  mocks.reload.mockResolvedValue(undefined);
  mocks.user.getIdToken.mockResolvedValue("fresh-token");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function page() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const element = () => (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <AccountPage />
      </I18nProvider>
    </QueryClientProvider>
  );
  return { ...render(element()), element };
}

test.each([
  [
    "en",
    "Verify your email to unlock your full allowance",
    "20%",
    "Send verification email",
    "I've verified my email",
  ],
  [
    "ar",
    "تحقق من بريدك للحصول على حصتك الكاملة",
    "٢٠٪",
    "إرسال رسالة التحقق",
    "تحققت من بريدي",
  ],
])(
  "unverified accounts see their reduced allowances and verification actions (%s)",
  async (language, title, allowance, send, refresh) => {
    localStorage.setItem("musicmute.web.language", language);
    page();
    expect(screen.getByRole("status")).toHaveTextContent(title);
    expect(screen.getByRole("status")).toHaveTextContent(allowance);
    expect(screen.getByRole("button", { name: send })).toBeEnabled();
    expect(screen.getByRole("button", { name: refresh })).toBeEnabled();
    await screen.findByText(/No devices found|لا توجد أجهزة/);
  },
);

test("verified accounts do not see reduced-allowance messaging or verification actions", () => {
  mocks.session.user.emailVerified = true;
  page();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Send verification email" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "I've verified my email" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Verified")).toBeInTheDocument();
});

test("resending verification uses the existing server action and keeps the reduced-allowance notice", async () => {
  page();
  await userEvent.click(
    screen.getByRole("button", { name: "Send verification email" }),
  );
  expect(mocks.api.post).toHaveBeenCalledWith("/auth/verification-emails", {});
  expect(
    await screen.findByText("Email sent. Check your inbox."),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Verify your email to unlock your full allowance"),
  ).toBeInTheDocument();
  expect(mocks.retry).not.toHaveBeenCalled();
});

test("verification reloads identity and forces a fresh token before session recovery", async () => {
  const calls: string[] = [];
  mocks.reload.mockImplementation(async () => {
    calls.push("reload");
    mocks.user.emailVerified = true;
  });
  let finishToken: (token: string) => void = () => {};
  mocks.user.getIdToken.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        calls.push("token");
        finishToken = resolve;
      }),
  );
  mocks.retry.mockImplementation(() => {
    calls.push("retry");
  });
  const { rerender, element } = page();
  await userEvent.click(
    screen.getByRole("button", { name: "I've verified my email" }),
  );
  expect(mocks.reload).toHaveBeenCalledWith(mocks.user);
  expect(mocks.user.getIdToken).toHaveBeenCalledWith(true);
  expect(mocks.retry).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "I've verified my email" }),
  ).toBeDisabled();
  expect(
    screen.getByText("Verify your email to unlock your full allowance"),
  ).toBeInTheDocument();
  finishToken("verified-token");
  await waitFor(() => expect(mocks.retry).toHaveBeenCalledOnce());
  expect(calls).toEqual(["reload", "token", "retry"]);

  mocks.session.user.emailVerified = true;
  rerender(element());
  expect(
    screen.queryByText("Verify your email to unlock your full allowance"),
  ).not.toBeInTheDocument();
});

test.each(["reload", "token"])(
  "a failed verification %s leaves the current session and offers another attempt",
  async (step) => {
    const operation = step === "reload" ? mocks.reload : mocks.user.getIdToken;
    operation.mockRejectedValue(new Error("NETWORK_ERROR"));
    page();
    await userEvent.click(
      screen.getByRole("button", { name: "I've verified my email" }),
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "I've verified my email" }),
    ).toBeEnabled();
    expect(
      screen.getByText("Verify your email to unlock your full allowance"),
    ).toBeInTheDocument();
  },
);
