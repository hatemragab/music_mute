import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { AuthScreen } from "./AuthScreen";

const authMocks = vi.hoisted(() => ({
  state: { phase: "signedOut", message: undefined as string | undefined },
  popup: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("./AuthProvider", () => ({
  auth: {},
  useAuth: () => ({ state: authMocks.state }),
}));
vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: vi.fn(function GoogleAuthProvider() {}),
  signInWithPopup: authMocks.popup,
  signInWithRedirect: authMocks.redirect,
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));

function mount() {
  return render(
    <I18nProvider>
      <AuthScreen />
    </I18nProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  authMocks.state.message = undefined;
  vi.stubGlobal("navigator", {
    userAgent: "Desktop Chrome",
    platform: "MacIntel",
    maxTouchPoints: 0,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("desktop Google sign-in keeps the popup and fences repeated clicks", () => {
  authMocks.popup.mockImplementation(() => new Promise(() => {}));
  mount();
  const google = screen.getByRole("button", { name: "Continue with Google" });
  fireEvent.click(google);
  fireEvent.click(google);
  expect(authMocks.popup).toHaveBeenCalledOnce();
  expect(authMocks.redirect).not.toHaveBeenCalled();
  expect(google).toBeDisabled();
});

test("iOS Chrome redirects only after an explicit Google click", () => {
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (iPhone) CriOS/140.0",
    platform: "iPhone",
    maxTouchPoints: 5,
  });
  authMocks.redirect.mockImplementation(() => new Promise(() => {}));
  mount();
  expect(authMocks.redirect).not.toHaveBeenCalled();
  const google = screen.getByRole("button", { name: "Continue with Google" });
  fireEvent.click(google);
  fireEvent.click(google);
  expect(authMocks.redirect).toHaveBeenCalledOnce();
  expect(authMocks.popup).not.toHaveBeenCalled();
  expect(google).toBeDisabled();
});

test("cancelled popup allows an explicit retry without automatically redirecting", async () => {
  authMocks.popup.mockRejectedValue({ code: "auth/popup-closed-by-user" });
  mount();
  const google = screen.getByRole("button", { name: "Continue with Google" });
  await act(async () => fireEvent.click(google));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Google sign-in did not finish. Please try again.",
  );
  expect(google).toBeEnabled();
  expect(authMocks.popup).toHaveBeenCalledOnce();
  expect(authMocks.redirect).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(google));
  expect(authMocks.popup).toHaveBeenCalledTimes(2);
});

test("redirect return errors stay localized and do not restart sign-in", () => {
  authMocks.state.message = "auth/popup-closed-by-user";
  mount();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Google sign-in did not finish. Please try again.",
  );
  fireEvent.click(screen.getByRole("button", { name: "العربية" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "لم يكتمل تسجيل الدخول باستخدام Google.",
  );
  expect(authMocks.redirect).not.toHaveBeenCalled();
  expect(authMocks.popup).not.toHaveBeenCalled();
});

test("a failed mobile redirect restores the Google action for user retry", async () => {
  vi.stubGlobal("navigator", {
    userAgent: "Android Chrome",
    platform: "Linux armv8l",
    maxTouchPoints: 5,
  });
  authMocks.redirect.mockRejectedValue({ code: "auth/popup-closed-by-user" });
  mount();
  const google = screen.getByRole("button", { name: "Continue with Google" });
  await act(async () => fireEvent.click(google));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Google sign-in did not finish. Please try again.",
  );
  expect(google).toBeEnabled();
  expect(authMocks.redirect).toHaveBeenCalledOnce();
});

test.each([
  ["en", "Allow sign-in pop-ups for this site"],
  ["ar", "اسمح بنوافذ تسجيل الدخول المنبثقة لهذا الموقع"],
])(
  "popup blocking gives an actionable error (%s)",
  async (language, message) => {
    localStorage.setItem("musicmute.web.language", language);
    authMocks.popup.mockRejectedValue({ code: "auth/popup-blocked" });
    mount();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name:
            language === "ar"
              ? "المتابعة باستخدام Google"
              : "Continue with Google",
        }),
      ),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(authMocks.redirect).not.toHaveBeenCalled();
  },
);

test.each([
  ["en", "Try a regular browser tab with site storage enabled."],
  ["ar", "جرّب صفحة متصفح عادية مع السماح بتخزين بيانات الموقع."],
])(
  "redirect storage failure gives an actionable error (%s)",
  (language, message) => {
    localStorage.setItem("musicmute.web.language", language);
    authMocks.state.message = "auth/web-storage-unsupported";
    mount();
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(authMocks.redirect).not.toHaveBeenCalled();
    expect(authMocks.popup).not.toHaveBeenCalled();
  },
);
