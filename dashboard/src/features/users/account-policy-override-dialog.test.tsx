import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AccountPolicyOverride } from "@/api/contracts";
import { AccountPolicyOverrideDialog } from "./account-policy-override-dialog";

const currentValues: AccountPolicyOverride["values"] = {
  monthlyProcessingSeconds: 7_200,
  maxDurationSeconds: 1_800,
  maxPreparedAudioBytes: 100_000_000,
  dailyUploadGrants: 20,
  monthlyUploadGrants: 200,
  monthlyConfirmedUploadBytes: 1_000_000_000,
  maxClientInputAttempts: 5,
  monthlyDownloadGrants: 200,
  monthlyEstimatedDownloadBytes: 10_000_000_000,
  maxRetainedOutputBytes: 1_000_000_000,
  signedUrlTtlSeconds: 600,
};

function setup(values = currentValues) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  const reauthenticate = vi.fn().mockResolvedValue(undefined);
  render(
    <AccountPolicyOverrideDialog
      open
      onOpenChange={onOpenChange}
      currentValues={values}
      currentOverride={{}}
      currentExpiry={null}
      reauthenticate={reauthenticate}
      onSave={onSave}
    />,
  );
  return { user: userEvent.setup(), onSave, onOpenChange, reauthenticate };
}

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Reason"), "Adjust account allowance");
  await user.click(
    screen.getByRole("button", { name: "Reauthenticate with Google" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Save override" }),
  );
}

describe("account policy override quotas", () => {
  it.each([20, 0])(
    "labels the current account quota of %s without calling it global",
    (dailyUploadGrants) => {
      setup({ ...currentValues, dailyUploadGrants });
      expect(screen.getByLabelText("Upload grants / UTC day")).toHaveAttribute(
        "placeholder",
        `Current account limit: ${dailyUploadGrants}`,
      );
      expect(screen.queryAllByPlaceholderText(/^Global:/)).toHaveLength(0);
      expect(
        screen.getByText(/Quota overrides set the full allowance/),
      ).toHaveTextContent("accounts without verified email receive one fifth");
    },
  );

  it("submits a raw partial override without comparing it to reduced account quotas", async () => {
    const { user, onSave, onOpenChange, reauthenticate } = setup();
    await user.type(screen.getByLabelText("Upload grants / UTC day"), "300");
    await save(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledWith({
      values: { dailyUploadGrants: 300 },
      expiresAt: null,
      reason: "Adjust account allowance",
    });
    expect(reauthenticate).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps a partial override open when the backend rejects its raw global-policy combination", async () => {
    const { user, onSave, onOpenChange } = setup();
    onSave.mockRejectedValue(
      new Error("Monthly upload grants cannot be lower than daily grants."),
    );
    await user.type(screen.getByLabelText("Upload grants / UTC month"), "50");
    await save(user);
    expect(onSave).toHaveBeenCalledWith({
      values: { monthlyUploadGrants: 50 },
      expiresAt: null,
      reason: "Adjust account allowance",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Monthly upload grants cannot be lower than daily grants.",
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByLabelText("Upload grants / UTC month")).toHaveValue(50);
    expect(screen.getByRole("button", { name: "Save override" })).toBeEnabled();
  });
});
