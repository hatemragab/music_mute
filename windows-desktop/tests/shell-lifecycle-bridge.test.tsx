// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { createDesktopIpcHandler } from "../src/main/desktop-ipc.js";
import { UI_DOCUMENT } from "../src/main/security.js";
import { ShellLifecycle } from "../src/main/shell-lifecycle.js";
import { DesktopApp } from "../src/renderer/app.js";
import { setLanguage } from "../src/renderer/i18n.js";
import { desktopUiFixture } from "./desktop-ui-fixtures.js";

afterEach(() => {
  cleanup();
  setLanguage("en");
  vi.restoreAllMocks();
});

it("keeps actual UI commands disabled through pending personal Quit and reports a late cleanup failure through the production ingress", async () => {
  let reject!: (error: Error) => void;
  const cleanupPending = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const quit = vi.fn(() => cleanupPending);
  const lifecycle = new ShellLifecycle({
    isBusy: () => false,
    confirmQuit: vi.fn(),
    cancelOwnedWork: vi.fn(),
    quit,
  });
  const f = desktopUiFixture({ personalQuitAvailable: true });
  const frame = { url: UI_DOCUMENT };
  const event = {
    senderFrame: frame,
    sender: { mainFrame: frame },
  } as Pick<IpcMainInvokeEvent, "senderFrame" | "sender">;
  const handler = createDesktopIpcHandler(
    async (command, current) => {
      expect(command.type).toBe("QUIT_PERSONAL");
      await lifecycle.quitPersonal(current);
      return { ok: true, snapshot: f.snapshot() };
    },
    (sender) => sender === event.sender,
  );
  f.bridge.quitPersonal = () => handler(event, { type: "QUIT_PERSONAL" });
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  const button = await screen.findByRole("button", {
    name: "Quit personal app",
  });
  fireEvent.click(button);
  await act(async () => {});
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(
    screen.getByRole("button", { name: "Library" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(quit).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => reject(new Error("PRIVATE_CLEANUP_SECRET_FIXTURE")));
  expect(button.hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("alert").textContent).toContain(
    "could not complete this action",
  );
  expect(document.body.textContent).not.toContain(
    "PRIVATE_CLEANUP_SECRET_FIXTURE",
  );
});
