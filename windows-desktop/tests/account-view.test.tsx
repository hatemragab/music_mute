// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AccountPanel } from "../src/renderer/account-view.js";
import type { AccountView } from "../src/shared/account-contracts.js";
afterEach(cleanup);
it("labels this Windows PC and limits Hide from history to past devices without implying session revocation", () => {
  const execute = vi.fn(async () => {}),
    current = "00000000-0000-4000-8000-000000000001",
    other = "00000000-0000-4000-8000-000000000002";
  const device = {
    platform: "windows",
    appVersion: "0.1.0",
    buildNumber: 1,
    metadataRevision: 1,
    osVersion: "10.0.19045",
    deviceModel: "Fixture PC",
    lastSeenAt: null,
  };
  render(
    <AccountPanel
      view={{
        ...signedIn,
        user: { ...signedIn.user!, providers: ["password", "apple.com"] },
        devices: [
          { ...device, installationId: current, current: true },
          { ...device, installationId: other, current: false },
        ],
      }}
      execute={execute}
    />,
  );
  expect(screen.getByText(/This Windows PC/u)).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: "Hide from history" }),
  ).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Unlink password" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Hide from history" }));
  expect(execute).toHaveBeenCalledWith({
    type: "HIDE_DEVICE",
    installationId: other,
  });
});
const signedOut: AccountView = {
  state: "signed-out",
  busy: false,
  online: false,
  googleSignInActive: false,
  user: null,
  devices: [],
  nextDeviceCursor: null,
  recovery: null,
  minimumBuild: null,
  access: { allowed: false, reason: "UNAUTHENTICATED" },
  verificationCooldownSeconds: 0,
  resetCooldownSeconds: 0,
  errorCode: null,
  noticeCode: null,
};
const signedIn: AccountView = {
  ...signedOut,
  state: "signed-in",
  online: true,
  user: {
    id: "a".repeat(24),
    displayName: "Fixture User",
    email: "fixture@example.test",
    emailVerified: false,
    providers: ["password", "google.com"],
    workerRegistrationAllowed: false,
  },
  destructiveReview: {
    accountId: "a".repeat(24),
    generation: "00000000-0000-4000-8000-000000000001",
  },
};
it("submits transient email credentials and clears password presentation immediately", async () => {
  const execute = vi.fn(async () => {});
  render(<AccountPanel view={signedOut} execute={execute} />);
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "fixture@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "fixture-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in with email" }));
  await waitFor(() =>
    expect(execute).toHaveBeenCalledWith({
      type: "SIGN_IN_EMAIL",
      email: "fixture@example.test",
      password: "fixture-password",
    }),
  );
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
    "",
  );
  expect(document.body.textContent).not.toContain("fixture-password");
});
it("keeps destructive actions behind explicit confirmation and lets the user decline", async () => {
  const execute = vi.fn(async () => {});
  render(<AccountPanel view={signedIn} execute={execute} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Request account deletion" }),
  );
  expect(execute).not.toHaveBeenCalled();
  expect(
    screen.getByRole("heading", { name: "Request account deletion?" }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Keep account unchanged" }),
  );
  expect(execute).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
  await waitFor(() =>
    expect(execute).toHaveBeenCalledWith({
      type: "LOGOUT_ALL",
      confirmed: true,
      expectedAccountId: signedIn.destructiveReview!.accountId,
      expectedSessionGeneration: signedIn.destructiveReview!.generation,
    }),
  );
});
it.each(["different account", "same account new session"])(
  "clears destructive review after %s instead of consenting for a replacement owner",
  (replacement) => {
    const execute = vi.fn(async () => {}),
      rendered = render(<AccountPanel view={signedIn} execute={execute} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out everywhere" }),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    const id =
      replacement === "different account" ? "b".repeat(24) : signedIn.user!.id;
    rendered.rerender(
      <AccountPanel
        view={{
          ...signedIn,
          user: { ...signedIn.user!, id },
          destructiveReview: {
            accountId: id,
            generation: "00000000-0000-4000-8000-000000000002",
          },
        }}
        execute={execute}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  },
);
it("a dialog submits the exact originally reviewed owner rather than reading a changed draft at confirmation", async () => {
  const execute = vi.fn(async () => {}),
    rendered = render(<AccountPanel view={signedIn} execute={execute} />);
  fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
  rendered.rerender(
    <AccountPanel
      view={{
        ...signedIn,
        destructiveReview: {
          ...signedIn.destructiveReview!,
          accountId: "b".repeat(24),
        },
      }}
      execute={execute}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
  await waitFor(() =>
    expect(execute).toHaveBeenCalledWith({
      type: "LOGOUT_ALL",
      confirmed: true,
      expectedAccountId: signedIn.destructiveReview!.accountId,
      expectedSessionGeneration: signedIn.destructiveReview!.generation,
    }),
  );
});
it("an absent trusted review cannot open or submit a destructive account confirmation", () => {
  const { destructiveReview: _review, ...unreviewed } = signedIn,
    execute = vi.fn(async () => {});
  render(<AccountPanel view={unreviewed} execute={execute} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Request account deletion" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(execute).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toBeTruthy();
});
it("shows recovery deadline and permits only available recovery", async () => {
  const execute = vi.fn(async () => {});
  const view: AccountView = {
    ...signedIn,
    state: "deletion-pending",
    online: false,
    recovery: {
      accountStatus: "deletion_pending",
      recoverUntil: "2026-10-24T00:00:00.000Z",
      recoveryAvailable: true,
      requestStatus: null,
    },
  };
  render(<AccountPanel view={view} execute={execute} />);
  expect(document.querySelector("time")?.getAttribute("datetime")).toBe(
    view.recovery?.recoverUntil,
  );
  fireEvent.click(screen.getByRole("button", { name: "Recover account" }));
  await waitFor(() =>
    expect(execute).toHaveBeenCalledWith({ type: "REQUEST_RECOVERY" }),
  );
});
it("keeps native/config unavailable account controls disabled and shows readable failure", async () => {
  const execute = vi.fn(async () => {});
  const { rerender } = render(
    <AccountPanel unavailable="CONFIGURATION_REQUIRED" execute={execute} />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Sign in with email",
      }) as HTMLButtonElement
    ).closest("fieldset")?.disabled,
  ).toBe(true);
  rerender(
    <AccountPanel
      view={{ ...signedOut, errorCode: "NETWORK_UNAVAILABLE" }}
      execute={execute}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain("local processing");
});
it("offers Google cancellation while other controls are busy and preserves accessible Google text", async () => {
  const execute = vi.fn(async () => {});
  render(
    <AccountPanel
      view={{ ...signedOut, busy: true, googleSignInActive: true }}
      execute={execute}
    />,
  );
  expect(
    screen
      .getByRole("button", { name: "Sign in with Google" })
      .querySelector("svg"),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Cancel Google sign-in" }),
  );
  await waitFor(() =>
    expect(execute).toHaveBeenCalledWith({ type: "CANCEL_SIGN_IN" }),
  );
});
