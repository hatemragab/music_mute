// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryPanel } from "../src/renderer/library-view.js";
import { setLanguage } from "../src/renderer/i18n.js";
import {
  DEFAULT_LIBRARY_QUERY,
  type LibraryView,
} from "../src/shared/library-contracts.js";
afterEach(() => {
  cleanup();
  setLanguage("en");
});
const view: LibraryView = {
  revision: 1,
  state: "ready",
  accountState: "signed-out",
  errorCode: null,
  query: DEFAULT_LIBRARY_QUERY,
  tracks: [
    {
      id: "local:one",
      jobId: null,
      title: "Saved voice",
      sourceKind: "file",
      videoId: null,
      durationSeconds: 60,
      sourceDurationSeconds: 60,
      trimEnabled: false,
      offline: true,
      online: false,
      originalAvailable: true,
      accountOwned: false,
      thumbnailUrl: null,
      starred: false,
      removed: false,
      playCount: 2,
      updatedAt: 1,
      canRename: false,
      canDeleteAccount: false,
      canExport: true,
    },
  ],
  visibleIds: ["local:one"],
  total: 1,
  nextCursor: null,
};
const fixture = () => ({
  view,
  busy: false,
  execute: vi.fn(async () => {}),
  play: vi.fn(),
  queue: vi.fn(),
  download: vi.fn(async () => {}),
  exportTrack: vi.fn(async () => {}),
  nextPage: vi.fn(async () => {}),
  historyCommand: vi.fn(async () => {}),
});
it("renders guest offline audio, dispatches trusted IDs and requires explicit result deletion", () => {
  const props = fixture();
  render(<LibraryPanel {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  expect(props.play).toHaveBeenCalledWith("local:one");
  fireEvent.click(screen.getByRole("button", { name: "Delete local result" }));
  expect(props.execute).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));
  expect(props.execute).toHaveBeenCalledWith({
    type: "DELETE_LOCAL",
    trackId: "local:one",
  });
  expect(
    screen.queryByRole("button", { name: "Delete account item" }),
  ).toBeNull();
});
it("offers last-good history recovery independently from audio playback", () => {
  const props = fixture();
  render(
    <LibraryPanel
      {...props}
      history={{
        state: "recovery-required",
        errorCode: "HISTORY_CORRUPT",
        entries: [],
      }}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Restore last good history" }),
  );
  expect(props.historyCommand).toHaveBeenCalledWith({ type: "RECOVER" });
  expect(
    (screen.getByRole("button", { name: "Play" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
it("offers direct original playback through the same trusted Library ID", () => {
  const props = fixture();
  render(<LibraryPanel {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Play original" }));
  expect(props.play).toHaveBeenCalledWith("local:one", "original");
});
it("binds Play next and Windows sharing to the selected Library ID without requiring local preparation", () => {
  const props = fixture(),
    playNext = vi.fn(),
    shareTrack = vi.fn(async () => {});
  render(
    <LibraryPanel
      {...props}
      playNext={playNext}
      shareTrack={shareTrack}
      shareResult="pending"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Play next" }));
  expect(playNext).toHaveBeenCalledWith("local:one");
  fireEvent.click(screen.getByRole("button", { name: "Share voice" }));
  expect(shareTrack).toHaveBeenCalledWith("local:one", "voice");
  fireEvent.click(screen.getByRole("button", { name: "Share original" }));
  expect(shareTrack).toHaveBeenCalledWith("local:one", "original");
  expect(
    screen.getByText(
      "Windows sharing is still pending. Its temporary audio is retained.",
    ),
  ).toBeTruthy();
});
it("keeps original play/export/share available after voice eviction without claiming that unavailable voice is online", () => {
  const props = fixture(),
    shareTrack = vi.fn(async () => {}),
    playNext = vi.fn();
  props.view = structuredClone(view);
  Object.assign(props.view.tracks[0]!, {
    offline: false,
    online: false,
    canExport: false,
  });
  const { container } = render(
    <LibraryPanel {...props} shareTrack={shareTrack} playNext={playNext} />,
  );
  expect(
    container.querySelector(".track-details .muted")!.textContent,
  ).toContain("Unavailable");
  expect(
    container.querySelector(".track-details .muted")!.textContent,
  ).not.toContain("Online");
  expect(
    (screen.getByRole("button", { name: "Play" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Add to queue" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Play next" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "Share voice" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Export voice" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Play original" }));
  fireEvent.click(screen.getByRole("button", { name: "Export original" }));
  fireEvent.click(screen.getByRole("button", { name: "Share original" }));
  expect(props.play).toHaveBeenCalledWith("local:one", "original");
  expect(props.exportTrack).toHaveBeenCalledWith("local:one", "original");
  expect(shareTrack).toHaveBeenCalledWith("local:one", "original");
});
it.each(["en", "ar"] as const)(
  "explains the incompatible trimmed account-save profile in %s while retaining exact voice play/export/share",
  (language) => {
    setLanguage(language);
    const props = fixture(),
      saveToAccount = vi.fn(async () => {}),
      shareTrack = vi.fn(async () => {});
    props.view = structuredClone(view);
    props.view.tracks[0]!.trimEnabled = true;
    render(
      <LibraryPanel
        {...props}
        saveToAccount={saveToAccount}
        shareTrack={shareTrack}
        accountSavingAvailable
      />,
    );
    const arabic = language === "ar";
    expect(
      screen.getByText(
        arabic
          ? "يتطلب الحفظ في الحساب صوتًا غير مختصر. لا يزال بإمكانك تشغيل هذا الصوت المختصر أو تصديره أو مشاركته."
          : "Account saving requires untrimmed audio. You can still play, export or share this trimmed voice.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: arabic ? "حفظ في حسابي" : "Save to my account",
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: arabic ? "تشغيل" : "Play" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: arabic ? "تصدير الصوت فقط" : "Export voice",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: arabic ? "مشاركة الصوت المعالج" : "Share voice",
      }),
    );
    expect(props.play).toHaveBeenCalledWith("local:one");
    expect(props.exportTrack).toHaveBeenCalledWith("local:one", "voice");
    expect(shareTrack).toHaveBeenCalledWith("local:one", "voice");
    expect(saveToAccount).not.toHaveBeenCalled();
  },
);
it("keeps actual online voice playback and queue intake available with an honest online label", () => {
  const props = fixture();
  props.view = structuredClone(view);
  Object.assign(props.view.tracks[0]!, {
    offline: false,
    online: true,
    canExport: false,
  });
  const { container } = render(<LibraryPanel {...props} />);
  expect(
    container.querySelector(".track-details .muted")!.textContent,
  ).toContain("Online");
  expect(
    (screen.getByRole("button", { name: "Play" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(
    (screen.getByRole("button", { name: "Add to queue" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
