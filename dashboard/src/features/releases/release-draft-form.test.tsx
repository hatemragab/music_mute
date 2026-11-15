import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ReleaseDraftForm } from "./release-draft-form";

describe("ReleaseDraftForm", () => {
  it("loads an editable next-release proposal and blocks older values", async () => {
    const user = userEvent.setup();
    const submit = vi.fn(async () => undefined);
    render(
      <ReleaseDraftForm
        open
        onOpenChange={() => undefined}
        getProposal={async () => ({
          platform: "android",
          source: "direct_apk",
          current: { versionName: "0.1.0", buildNumber: 1 },
          suggested: { versionName: "0.1.1", buildNumber: 2 },
        })}
        onSubmit={submit}
      />,
    );

    expect(await screen.findByText("Current release: 0.1.0 (1)")).toBeVisible();
    expect(screen.getByLabelText("Version name")).toHaveValue("0.1.1");
    expect(screen.getByLabelText("Build number")).toHaveValue(2);

    await user.type(screen.getByLabelText("English changelog"), "New release");
    await user.type(screen.getByLabelText("Reason"), "Ship new release");
    await user.clear(screen.getByLabelText("Version name"));
    await user.type(screen.getByLabelText("Version name"), "0.1.0");
    expect(screen.getByText("Version must be newer than 0.1.0.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create draft" })).toBeDisabled();

    await user.clear(screen.getByLabelText("Version name"));
    await user.type(screen.getByLabelText("Version name"), "0.2.0");
    await user.clear(screen.getByLabelText("Build number"));
    await user.type(screen.getByLabelText("Build number"), "1");
    expect(
      screen.getByText("Build number must be greater than 1."),
    ).toBeVisible();

    await user.clear(screen.getByLabelText("Build number"));
    await user.type(screen.getByLabelText("Build number"), "5");
    await user.click(screen.getByRole("button", { name: "Create draft" }));

    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        platform: "android",
        source: "direct_apk",
        versionName: "0.2.0",
        buildNumber: 5,
        changelogEn: "New release",
        storeUrl: null,
        reason: "Ship new release",
      }),
    );
  });

  it("refreshes the proposal when the platform changes", async () => {
    const user = userEvent.setup();
    render(
      <ReleaseDraftForm
        open
        onOpenChange={() => undefined}
        getProposal={async (platform, source) =>
          platform === "ios" && source === "app_store"
            ? {
                platform,
                source,
                current: { versionName: "0.5.0", buildNumber: 8 },
                suggested: { versionName: "0.5.1", buildNumber: 9 },
              }
            : {
                platform,
                source,
                current: { versionName: "0.1.0", buildNumber: 1 },
                suggested: { versionName: "0.1.1", buildNumber: 2 },
              }
        }
        onSubmit={async () => undefined}
      />,
    );

    await screen.findByText("Current release: 0.1.0 (1)");
    await user.click(screen.getByRole("combobox", { name: "Platform" }));
    await user.click(screen.getByRole("option", { name: "iOS" }));

    expect(await screen.findByText("Current release: 0.5.0 (8)")).toBeVisible();
    expect(screen.getByLabelText("Version name")).toHaveValue("0.5.1");
    expect(screen.getByLabelText("Build number")).toHaveValue(9);
  });
});
