import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdminAudioPlayer } from "./admin-audio-player";

describe("AdminAudioPlayer", () => {
  it("offers a separately audited download action after playback fails", async () => {
    const requestDownload = vi.fn();
    const user = userEvent.setup();
    render(
      <AdminAudioPlayer
        grant={{
          url: "https://media.example.test/vocals.mp3",
          expiresAt: "2099-01-01T00:00:00.000Z",
          bytes: 10,
          contentType: "audio/mpeg",
          filename: "vocals.mp3",
        }}
        label="Vocals preview"
        onExpired={vi.fn()}
        onDownloadFallback={requestDownload}
      />,
    );

    fireEvent.error(screen.getByLabelText("Vocals preview"));
    expect(screen.getByRole("alert")).toHaveTextContent(/could not play/i);
    await user.click(
      screen.getByRole("button", { name: "Request download access" }),
    );
    expect(requestDownload).toHaveBeenCalledOnce();
  });
});
