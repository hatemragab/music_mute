// @vitest-environment jsdom
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Script } from "node:vm";
import { randomUUID, randomBytes } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createDesktopIpcHandler } from "../src/main/desktop-ipc.js";
import { DesktopApp } from "../src/renderer/app.js";
import { desktopUiFixture } from "./desktop-ui-fixtures.js";
import type {
  DesktopCommand,
  DesktopReply,
  DesktopSnapshot,
} from "../src/shared/contracts.js";
import { setLanguage } from "../src/renderer/i18n.js";
import { UI_DOCUMENT } from "../src/main/security.js";
import { PlaybackController } from "../src/main/player/controller.js";
import { DEFAULT_LIBRARY_QUERY } from "../src/shared/library-contracts.js";
import { SetupAssistanceController } from "../src/main/setup-assistance/controller.js";

afterEach(() => {
  cleanup();
  setLanguage("en");
  vi.restoreAllMocks();
});
async function transport(
  execute: (
    command: DesktopCommand,
    senderCurrent: () => boolean,
  ) => Promise<DesktopReply>,
) {
  const frame = { url: UI_DOCUMENT },
    event = { senderFrame: frame, sender: { mainFrame: frame } } as Pick<
      IpcMainInvokeEvent,
      "senderFrame" | "sender"
    >,
    handler = createDesktopIpcHandler(
      execute,
      (sender) => sender === event.sender,
    ),
    listeners = new Set<(event: unknown, snapshot: DesktopSnapshot) => void>(),
    invoked = vi.fn(async (channel: string, command: unknown) => {
      expect(channel).toBe("musicmute:command");
      return handler(event, command);
    });
  // Build in the real Node realm; JSDOM's Uint8Array realm cannot host esbuild.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import {build} from "esbuild"; const result=await build({entryPoints:["src/preload/index.ts"],bundle:true,platform:"node",format:"cjs",external:["electron"],write:false}); process.stdout.write(result.outputFiles[0].text);',
    ],
    { maxBuffer: 256 * 1024 },
  );
  new Script(stdout).runInNewContext({
    require: (name: string) => {
      expect(name).toBe("electron");
      return {
        contextBridge: {
          exposeInMainWorld: (key: string, value: unknown) => {
            expect(key).toBe("musicmute");
            window.musicmute = value as typeof window.musicmute;
          },
        },
        ipcRenderer: {
          invoke: invoked,
          on: (
            channel: string,
            listener: typeof listeners extends Set<infer L> ? L : never,
          ) => {
            expect(channel).toBe("musicmute:snapshot");
            listeners.add(listener);
          },
          removeListener: (
            channel: string,
            listener: typeof listeners extends Set<infer L> ? L : never,
          ) => {
            expect(channel).toBe("musicmute:snapshot");
            listeners.delete(listener);
          },
        },
        webUtils: { getPathForFile: () => "" },
      };
    },
  });
  return {
    handler,
    event,
    invoked,
    listeners,
    publish: (snapshot: DesktopSnapshot) => {
      for (const listener of listeners) listener({}, snapshot);
    },
  };
}
it("receives fixed Setup actions through the source-built preload and real ingress/controller/UI without exposing paths", async () => {
  const f = desktopUiFixture({ section: "setup" }),
    copy = vi.fn(async (_signal: AbortSignal, _current: () => boolean) => {}),
    controller = new SetupAssistanceController({
      inspect: async () => ({
        extension: "available",
        chrome: "available",
        modelFolder: "unavailable",
      }),
      copyExtensionPath: copy,
      openChromeExtensions: async () => {},
      revealExtension: async () => {},
      revealModelFolder: async () => {
        throw new Error("UNEXPECTED_MODEL_REVEAL");
      },
    });
  await controller.refresh(new AbortController().signal);
  const off = controller.subscribe((view) =>
    f.publish({ setupAssistance: view }),
  );
  const executed = vi.fn(
    async (
      command: DesktopCommand,
      senderCurrent: () => boolean,
    ): Promise<DesktopReply> => {
      if (command.type === "SETUP_ASSISTANCE")
        await controller.execute(
          command.command,
          new AbortController().signal,
          senderCurrent,
        );
      return { ok: true, snapshot: f.snapshot() };
    },
  );
  const t = await transport(executed);
  const publish = controller.subscribe(() => t.publish(f.snapshot()));
  render(<DesktopApp />);
  fireEvent.click(await screen.findByText("Development installation"));
  fireEvent.click(
    screen.getByRole("button", { name: "Copy extension folder path" }),
  );
  await waitFor(() => expect(copy).toHaveBeenCalledOnce());
  expect(executed).toHaveBeenCalledWith(
    {
      type: "SETUP_ASSISTANCE",
      command: { type: "COPY_EXTENSION_PATH" },
    },
    expect.any(Function),
  );
  expect(
    screen.queryByRole("button", { name: "Show voice model folder" }),
  ).toBeNull();
  await expect(
    t.handler(t.event, {
      type: "SETUP_ASSISTANCE",
      command: { type: "REVEAL_EXTENSION", path: "C:\\private" },
    }),
  ).resolves.toEqual({ ok: false, errorCode: "INVALID_REQUEST" });
  expect(copy).toHaveBeenCalledOnce();
  cleanup();
  publish();
  off();
  await controller.dispose();
});
it("runs the source-built restricted preload through production Main ingress and actual UI snapshots", async () => {
  const f = desktopUiFixture(),
    executed = vi.fn(async (command: DesktopCommand): Promise<DesktopReply> => {
      if (command.type === "NAVIGATE") f.publish({ section: command.section });
      if (command.type === "SELECT_INPUT")
        f.publish({
          selectedInput: {
            capability: randomUUID(),
            name: "Selected fixture.wav",
            bytes: 1024,
          },
        });
      return { ok: true, snapshot: f.snapshot() };
    }),
    t = await transport(executed);
  expect(Object.isFrozen(window.musicmute)).toBe(true);
  expect(Object.keys(window.musicmute)).not.toContain("invoke");
  render(<DesktopApp />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose audio or video" }),
  );
  await screen.findByText("Selected: Selected fixture.wav");
  expect(executed).toHaveBeenCalledWith(
    { type: "SELECT_INPUT" },
    expect.any(Function),
  );
  fireEvent.click(screen.getByRole("button", { name: "Library" }));
  await screen.findByRole("heading", { name: "Library", level: 1 });
  expect(executed).toHaveBeenCalledWith(
    {
      type: "NAVIGATE",
      section: "library",
    },
    expect.any(Function),
  );
  await act(async () => {
    f.publish({ section: "worker" });
    t.publish(f.snapshot());
  });
  await screen.findByRole("heading", { name: "Worker", level: 1 });
  cleanup();
  expect(t.listeners.size).toBe(0);
});
it("rejects wrong/subframe peers and closed-schema injection before trusted service dispatch", async () => {
  const f = desktopUiFixture(),
    executed = vi.fn(async (): Promise<DesktopReply> => ({
      ok: true,
      snapshot: f.snapshot(),
    })),
    t = await transport(executed);
  const wrong = {
    ...t.event,
    senderFrame: { url: "https://untrusted.example" },
  } as typeof t.event;
  expect(await t.handler(wrong, { type: "GET_SNAPSHOT" })).toEqual({
    ok: false,
    errorCode: "UNAUTHORIZED",
  });
  const subframe = {
    ...t.event,
    senderFrame: { url: UI_DOCUMENT },
  } as typeof t.event;
  expect(await t.handler(subframe, { type: "GET_SNAPSHOT" })).toEqual({
    ok: false,
    errorCode: "UNAUTHORIZED",
  });
  const foreignFrame = { url: UI_DOCUMENT };
  const replacedWindow = {
    senderFrame: foreignFrame,
    sender: { mainFrame: foreignFrame },
  } as typeof t.event;
  expect(await t.handler(replacedWindow, { type: "GET_SNAPSHOT" })).toEqual({
    ok: false,
    errorCode: "UNAUTHORIZED",
  });
  expect(
    await t.handler(t.event, {
      type: "NAVIGATE",
      section: "worker",
      shell: "arbitrary",
    }),
  ).toEqual({ ok: false, errorCode: "INVALID_REQUEST" });
  expect(executed).not.toHaveBeenCalled();
});
it("rechecks the captured current-window authority before queued service dispatch", async () => {
  const frame = { url: UI_DOCUMENT },
    sender = { mainFrame: frame } as IpcMainInvokeEvent["sender"],
    event = { sender, senderFrame: frame } as Pick<
      IpcMainInvokeEvent,
      "sender" | "senderFrame"
    >,
    f = desktopUiFixture();
  let current = true,
    release!: () => void;
  const admitted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sideEffect = vi.fn();
  const handler = createDesktopIpcHandler(
    async (_command, senderCurrent) => {
      await admitted;
      if (!senderCurrent()) return { ok: false, errorCode: "UNAUTHORIZED" };
      sideEffect();
      return { ok: true, snapshot: f.snapshot() };
    },
    (peer) => current && peer === sender,
  );
  const command = handler(event, { type: "SELECT_INPUT" });
  current = false;
  release();
  expect(await command).toEqual({ ok: false, errorCode: "UNAUTHORIZED" });
  expect(sideEffect).not.toHaveBeenCalled();
  expect(await handler(event, { type: "GET_SNAPSHOT" })).toEqual({
    ok: false,
    errorCode: "UNAUTHORIZED",
  });
});
it("normalizes unexpected service rejection without exposing private errors through the real bridge", async () => {
  await transport(async () => {
    throw new Error("private token/path/stack fixture");
  });
  const reply = await window.musicmute.getSnapshot();
  expect(reply).toEqual({ ok: false, errorCode: "OPERATION_FAILED" });
  expect(JSON.stringify(reply)).not.toContain("private");
});
it("carries every named queue edit through UI, built preload, production ingress and the real player occurrence fence", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const ids = ["local:one", "local:two", "c".repeat(24)],
    titles = ["First voice", "Second voice", "Third voice"],
    release = vi.fn(async () => {}),
    allowed = new Set(ids),
    opened: string[] = [],
    player = new PlaybackController({
      canQueue: (id) => allowed.has(id),
      available: (id) => ids.includes(id),
      open: async (id) => {
        opened.push(id);
        return {
          url: `http://127.0.0.1:1234/media/${randomUUID()}?capability=${randomBytes(32).toString("base64url")}`,
          originalDuration: 60,
          sourceDuration: 60,
          trimmed: false,
          accountOwned: id === ids[2],
          release,
        };
      },
    });
  await player.execute({ type: "LOAD", trackId: ids[0]! });
  const f = desktopUiFixture({
    section: "library",
    account: { state: "signed-in", displayName: "Fixture A" },
    playback: player.view(),
    library: {
      revision: 1,
      state: "ready",
      accountState: "signed-out",
      errorCode: null,
      query: DEFAULT_LIBRARY_QUERY,
      visibleIds: ids,
      total: 3,
      nextCursor: null,
      tracks: ids.map((id, index) => ({
        id,
        title: titles[index]!,
        jobId: index === 2 ? id : null,
        sourceKind: "file",
        videoId: null,
        durationSeconds: 60,
        sourceDurationSeconds: 60,
        trimEnabled: false,
        offline: true,
        online: false,
        originalAvailable: true,
        accountOwned: index === 2,
        thumbnailUrl: null,
        starred: false,
        removed: false,
        playCount: 0,
        updatedAt: index,
        canRename: false,
        canDeleteAccount: false,
        canExport: true,
      })),
    },
  });
  let holdQueuedPlay = false,
    resumeQueued!: () => void,
    queuedStarted!: () => void;
  const queuedWaiting = new Promise<void>((resolve) => {
      resumeQueued = resolve;
    }),
    queuedAdmission = new Promise<void>((resolve) => {
      queuedStarted = resolve;
    });
  const executed = vi.fn(
      async (command: DesktopCommand): Promise<DesktopReply> => {
        if (command.type === "PLAYBACK") {
          if (holdQueuedPlay && command.command.type === "QUEUE_PLAY") {
            queuedStarted();
            await queuedWaiting;
          }
          await player.execute(command.command);
        }
        return { ok: true, snapshot: f.snapshot() };
      },
    ),
    t = await transport(executed),
    off = player.subscribe((view) => {
      f.publish({ playback: view });
      t.publish(f.snapshot());
    });
  render(<DesktopApp />);
  await screen.findByRole("heading", { name: "Library", level: 1 });
  const row = (name: string) =>
    within(screen.getByRole("heading", { name }).closest("article")!);
  fireEvent.click(
    row("Second voice").getByRole("button", { name: "Add to queue" }),
  );
  await waitFor(() => expect(player.view().queue).toEqual([ids[1]]));
  fireEvent.click(
    row("Third voice").getByRole("button", { name: "Play next" }),
  );
  await waitFor(() => expect(player.view().queue).toEqual([ids[2], ids[1]]));
  fireEvent.click(
    screen.getByRole("button", { name: "More playback controls" }),
  );
  const stale = {
    type: "QUEUE_EDIT" as const,
    action: "remove" as const,
    trackId: ids[1]!,
    index: 1,
    generation: player.view().generation,
    queueRevision: player.view().queueRevision!,
  };
  fireEvent.click(screen.getByRole("button", { name: "Move Second voice up" }));
  await waitFor(() => expect(player.view().queue).toEqual([ids[1], ids[2]]));
  const url = player.view().url,
    generation = player.view().generation;
  expect(await window.musicmute.playback(stale)).toEqual({
    ok: false,
    errorCode: "OPERATION_FAILED",
  });
  expect(player.view().queue).toEqual([ids[1], ids[2]]);
  expect(player.view()).toMatchObject({ url, generation });
  fireEvent.click(
    screen.getByRole("button", { name: "Remove Third voice from queue" }),
  );
  await waitFor(() => expect(player.view().queue).toEqual([ids[1]]));
  const upNext = within(
    screen.getByRole("heading", { name: "Up Next" }).parentElement!,
  );
  fireEvent.click(upNext.getByRole("button", { name: "Second voice" }));
  await waitFor(() => expect(player.view().trackId).toBe(ids[1]));
  expect(player.view().queue).toEqual([]);
  fireEvent.click(
    row("First voice").getByRole("button", { name: "Add to queue" }),
  );
  await waitFor(() => expect(player.view().queue).toEqual([ids[0]]));
  fireEvent.click(screen.getByRole("button", { name: "Clear queue" }));
  await waitFor(() => expect(player.view().queue).toEqual([]));
  expect(player.view().trackId).toBe(ids[1]);
  fireEvent.click(
    row("Third voice").getByRole("button", { name: "Add to queue" }),
  );
  await waitFor(() => expect(player.view().queue).toEqual([ids[2]]));
  holdQueuedPlay = true;
  const retainedUrl = player.view().url;
  fireEvent.click(upNext.getByRole("button", { name: "Third voice" }));
  await queuedAdmission;
  await act(async () => {
    allowed.delete(ids[2]!);
    await player.invalidateOwner((id) => id === ids[2]);
    f.publish({
      account: { state: "signed-out", displayName: null },
      library: {
        ...f.snapshot().library!,
        accountState: "signed-out",
        tracks: f
          .snapshot()
          .library!.tracks.filter((track) => track.id !== ids[2]),
        visibleIds: ids.slice(0, 2),
        total: 2,
      },
    });
    t.publish(f.snapshot());
    resumeQueued();
    await queuedWaiting;
  });
  await screen.findByText("Playback could not complete this action.");
  expect(player.view()).toMatchObject({
    trackId: ids[1],
    url: retainedUrl,
    queue: [],
  });
  expect(opened).not.toContain(ids[2]);
  expect(
    executed.mock.calls.map(([command]) =>
      command.type === "PLAYBACK" ? command.command.type : command.type,
    ),
  ).toContain("QUEUE_PLAY");
  cleanup();
  off();
  await player.dispose();
});
