import { expect, it, vi } from "vitest";
import { ShellLifecycle } from "../src/main/shell-lifecycle.js";
import {
  DesktopPersonalController,
  type DesktopPersonalPort,
} from "../src/main/desktop-personal.js";
it("leaves active work alive when personal quit confirmation is declined", async () => {
  const cancelOwnedWork = vi.fn();
  const quit = vi.fn();
  const lifecycle = new ShellLifecycle({
    isBusy: () => true,
    confirmQuit: async () => false,
    cancelOwnedWork,
    quit,
  });
  expect(await lifecycle.quitPersonal()).toBe(false);
  expect(cancelOwnedWork).not.toHaveBeenCalled();
  expect(quit).not.toHaveBeenCalled();
});
it("serializes quit and cancels only its owned work before quitting", async () => {
  let busy = true;
  const events: string[] = [];
  let resolve!: (value: boolean) => void;
  const lifecycle = new ShellLifecycle({
    isBusy: () => busy,
    confirmQuit: () =>
      new Promise((done) => {
        resolve = done;
      }),
    cancelOwnedWork: async () => {
      events.push("cancel-personal");
      busy = false;
    },
    quit: () => {
      events.push("quit");
    },
  });
  const first = lifecycle.quitPersonal();
  const second = lifecycle.quitPersonal();
  expect(first).toBe(second);
  resolve(true);
  await first;
  expect(events).toEqual(["cancel-personal", "quit"]);
});
it("does not quit if cancellation failed or owned work remains active", async () => {
  const quit = vi.fn();
  const lifecycle = new ShellLifecycle({
    isBusy: () => true,
    confirmQuit: async () => true,
    cancelOwnedWork: async () => {},
    quit,
  });
  await expect(lifecycle.quitPersonal()).rejects.toThrow(
    "PERSONAL_SHUTDOWN_PENDING",
  );
  expect(quit).not.toHaveBeenCalled();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("retains the actual command and coalesced reservation until asynchronous quit cleanup completes", async () => {
  const cleanup = deferred<void>();
  const quit = vi.fn(() => cleanup.promise);
  const lifecycle = new ShellLifecycle({
    isBusy: () => false,
    confirmQuit: vi.fn(),
    cancelOwnedWork: vi.fn(),
    quit,
  });
  let commandBusy = true;
  const first = lifecycle.quitPersonal();
  const command = first.finally(() => {
    commandBusy = false;
  });
  await Promise.resolve();
  expect(commandBusy).toBe(true);
  expect(lifecycle.quitPersonal()).toBe(first);
  expect(quit).toHaveBeenCalledTimes(1);
  cleanup.resolve();
  expect(await command).toBe(true);
  expect(commandBusy).toBe(false);
});

it("propagates late quit failure without releasing the command early and permits an explicit later attempt", async () => {
  const cleanup = deferred<void>();
  const quit = vi.fn().mockImplementationOnce(() => cleanup.promise);
  const lifecycle = new ShellLifecycle({
    isBusy: () => false,
    confirmQuit: vi.fn(),
    cancelOwnedWork: vi.fn(),
    quit,
  });
  const command = lifecycle.quitPersonal();
  const rejected = expect(command).rejects.toThrow("PERSONAL_SHUTDOWN_PENDING");
  let finished = false;
  void command.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(lifecycle.quitPersonal()).toBe(command);
  cleanup.reject(new Error("PERSONAL_SHUTDOWN_PENDING"));
  await rejected;
  expect(finished).toBe(true);
  expect(await lifecycle.quitPersonal()).toBe(true);
  expect(quit).toHaveBeenCalledTimes(2);
});

it.each(["window", "controller"])(
  "a replaced %s during quit confirmation cannot cancel or close newer personal state",
  async (replacement) => {
    const confirmation = deferred<boolean>();
    const owner = { window: {}, controller: {} };
    const captured = { ...owner };
    const current = () =>
      owner.window === captured.window &&
      owner.controller === captured.controller;
    const cancelOwnedWork = vi.fn();
    const quit = vi.fn();
    const lifecycle = new ShellLifecycle({
      isBusy: () => true,
      confirmQuit: () => confirmation.promise,
      cancelOwnedWork,
      quit,
    });
    const command = lifecycle.quitPersonal(current);
    const rejected = expect(command).rejects.toThrow("PERSONAL_OWNER_CHANGED");
    owner[replacement as "window" | "controller"] = {};
    confirmation.resolve(true);
    await rejected;
    expect(cancelOwnedWork).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  },
);

it("ownership switching during old-owner cancellation prevents closing the new window", async () => {
  const cancellation = deferred<void>();
  let current = true;
  let busy = true;
  const quit = vi.fn();
  const cancelOwnedWork = vi.fn(() => cancellation.promise);
  const lifecycle = new ShellLifecycle({
    isBusy: () => busy,
    confirmQuit: async () => true,
    cancelOwnedWork,
    quit,
  });
  const command = lifecycle.quitPersonal(() => current);
  const rejected = expect(command).rejects.toThrow("PERSONAL_OWNER_CHANGED");
  await Promise.resolve();
  expect(cancelOwnedWork).toHaveBeenCalledTimes(1);
  current = false;
  busy = false;
  cancellation.resolve();
  await rejected;
  expect(quit).not.toHaveBeenCalled();
});

it("rejects already stale ownership before any read, confirmation or effect", async () => {
  const port = {
    isBusy: vi.fn(() => true),
    confirmQuit: vi.fn(),
    cancelOwnedWork: vi.fn(),
    quit: vi.fn(),
  };
  await expect(
    new ShellLifecycle(port).quitPersonal(() => false),
  ).rejects.toThrow("PERSONAL_OWNER_CHANGED");
  for (const callback of Object.values(port))
    expect(callback).not.toHaveBeenCalled();
});

it("retains legacy synchronous quit compatibility and skips confirmation when idle", async () => {
  const port = {
    isBusy: vi.fn(() => false),
    confirmQuit: vi.fn(),
    cancelOwnedWork: vi.fn(),
    quit: vi.fn(() => {}),
  };
  expect(await new ShellLifecycle(port).quitPersonal()).toBe(true);
  expect(port.quit).toHaveBeenCalledTimes(1);
  expect(port.confirmQuit).not.toHaveBeenCalled();
  expect(port.cancelOwnedWork).not.toHaveBeenCalled();
});
it("actual local staging prompts before any session job event and waits confirmed intake cleanup before personal Quit", async () => {
  const staged = deferred<string>();
  const entered = deferred<void>();
  let stagingSignal: AbortSignal | undefined;
  const port: DesktopPersonalPort = {
    scope: () => null,
    stage: async (_capability, _window, _owner, _scope, signal) => {
      stagingSignal = signal;
      entered.resolve();
      return staged.promise;
    },
    command: vi.fn(async (command) => ({
      version: 1 as const,
      requestId: command.requestId,
      ok: true,
      jobs: [],
    })),
    watch: vi.fn(async () => {}),
  };
  const personal = new DesktopPersonalController(port);
  const intake = personal.execute(
    {
      type: "SUBMIT_FILE",
      capability: "00000000-0000-4000-8000-000000000001",
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  await entered.promise;
  const backgroundSessionBusy = false;
  expect(personal.view()).toMatchObject({ busy: true, jobs: [] });
  const confirmQuit = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const quit = vi.fn();
  const lifecycle = new ShellLifecycle({
    isBusy: () => personal.view().busy || backgroundSessionBusy,
    confirmQuit,
    cancelOwnedWork: () => personal.cancelOwnedWork(),
    quit,
  });
  expect(await lifecycle.quitPersonal()).toBe(false);
  expect(stagingSignal?.aborted).toBe(false);
  expect(port.command).not.toHaveBeenCalled();
  const retiring = lifecycle.quitPersonal();
  await Promise.resolve();
  expect(stagingSignal?.aborted).toBe(true);
  expect(quit).not.toHaveBeenCalled();
  expect(port.command).not.toHaveBeenCalled();
  staged.resolve("00000000-0000-4000-8000-000000000002");
  await intake;
  expect(await retiring).toBe(true);
  expect(quit).toHaveBeenCalledTimes(1);
  expect(confirmQuit).toHaveBeenCalledTimes(2);
  expect(port.command).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "detach",
      ownerId: personal.ownerId,
    }),
  );
  expect(personal.view().busy).toBe(false);
  await personal.dispose();
});
