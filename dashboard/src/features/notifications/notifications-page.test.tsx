import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsPage } from "./notifications-page";
import { OperationOutcomeUnknownError } from "@/api/api-client";
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  reauthenticate: vi.fn(),
  can: vi.fn(),
  live: vi.fn(),
}));
vi.mock("@/auth/admin-session", () => ({
  useApiClient: () => ({}),
  useAdminSession: () => ({
    can: mocks.can,
    reauthenticate: mocks.reauthenticate,
  }),
}));
vi.mock("@/realtime/hooks", () => ({ useLiveQuery: mocks.live }));
vi.mock("./notifications-api", () => ({ sendNotification: mocks.send }));
beforeEach(() => {
  mocks.can.mockReturnValue(true);
  mocks.live.mockReturnValue({ data: { items: [], nextCursor: null } });
  mocks.send.mockResolvedValue({ id: "campaign" });
  mocks.reauthenticate.mockResolvedValue(undefined);
});
async function review() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Title"), "Maintenance");
  await user.type(screen.getByLabelText("Message"), "We will be back soon");
  await user.click(screen.getByRole("button", { name: "Review broadcast" }));
  return user;
}
describe("notification composer", () => {
  it("requires review, reason and fresh auth before sending once", async () => {
    render(<NotificationsPage />);
    expect(
      screen.getByRole("button", { name: "Review broadcast" }),
    ).toBeDisabled();
    const user = await review();
    const dialog = within(screen.getByRole("dialog"));
    expect(mocks.send).not.toHaveBeenCalled();
    await user.type(dialog.getByLabelText("Reason"), "Scheduled maintenance");
    await user.click(
      dialog.getByRole("button", { name: "Reauthenticate with Google" }),
    );
    await user.click(
      await dialog.findByRole("button", { name: "Send broadcast" }),
    );
    expect(mocks.reauthenticate).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        title: "Maintenance",
        body: "We will be back soon",
        reason: "Scheduled maintenance",
        operationId: expect.any(String),
      }),
    );
    expect(screen.getByLabelText("Title")).toHaveValue("");
  });
  it("blocks another broadcast after an unresolved response", async () => {
    mocks.send.mockRejectedValue(
      new OperationOutcomeUnknownError("fixture-op", "Unresolved"),
    );
    render(<NotificationsPage />);
    const user = await review();
    await user.type(screen.getByLabelText("Reason"), "Scheduled maintenance");
    await user.click(
      screen.getByRole("button", { name: "Reauthenticate with Google" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Send broadcast" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sending is disabled",
    );
    expect(
      screen.getByRole("button", { name: "Review broadcast" }),
    ).toBeDisabled();
    expect(mocks.send).toHaveBeenCalledOnce();
  });
  it("hides composition without send permission and reports history failures", () => {
    mocks.can.mockReturnValue(false);
    mocks.live.mockReturnValue({
      isError: true,
      error: new Error("Connection unavailable"),
    });
    render(<NotificationsPage />);
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    expect(screen.getByText("Connection unavailable")).toBeInTheDocument();
  });
});
