import { expect, it, vi } from "vitest";
import {
  DesktopPersonalController,
  type DesktopPersonalLifecycle,
  type DesktopPersonalPort,
} from "../src/main/desktop-personal.js";
import type {
  PersonalJobView,
  PersonalCommand,
} from "../src/shared/personal-contracts.js";
import type { SessionAccountScope } from "../src/shared/session-contracts.js";
import type { PersonalPlaybackIntent } from "../src/main/personal/playback-intents.js";
import type { PersonalReply } from "../src/main/personal/session-port.js";
const id = "00000000-0000-4000-8000-000000000001";
function fixture(lifecycle: DesktopPersonalLifecycle = {}) {
  let scope: SessionAccountScope | null = null,
    watcher: (jobs: PersonalJobView[]) => void = () => {};
  const commands: PersonalCommand[] = [];
  const job = (ownerId: string): PersonalJobView => ({
    id,
    ownerId,
    state: "preparing",
    stage: "queued",
    progress: null,
    name: "Fixture",
    error: null,
    original: null,
    vocals: null,
  });
  const port: DesktopPersonalPort = {
    command: vi.fn(async (command) => {
      commands.push(command);
      return {
        version: 1 as const,
        requestId: command.requestId,
        ok: true,
        ...(command.action === "submit"
          ? { job: job(command.submission.ownerId) }
          : { jobs: [] }),
      };
    }),
    stage: vi.fn(async () => id),
    scope: () => scope,
    watch: vi.fn(async (_owner, notify, signal) => {
      watcher = notify;
      await new Promise<void>((done) =>
        signal.addEventListener("abort", () => done(), { once: true }),
      );
    }),
  };
  const controller = new DesktopPersonalController(port, lifecycle);
  return {
    controller,
    port,
    commands,
    job,
    setScope: (value: SessionAccountScope | null) => {
      scope = value;
    },
    emit: (jobs: PersonalJobView[]) => watcher(jobs),
  };
}
it("captures fresh request intent before staged intake and maps that exact UUID to the accepted job", async () => {
  const events: string[] = [],
    created = vi.fn((_intent: PersonalPlaybackIntent) => {
      events.push("created");
    }),
    accepted = vi.fn(
      (_intent: PersonalPlaybackIntent, _job: PersonalJobView) => {
        events.push("accepted");
      },
    ),
    f = fixture({ created, accepted });
  f.port.stage = vi.fn(async () => {
    events.push("stage");
    expect(created).toHaveBeenCalledOnce();
    return id;
  });
  await f.controller.execute(
    {
      type: "SUBMIT_FILE",
      capability: id,
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  const submit = f.commands[0]!;
  if (submit.action !== "submit") throw new Error("EXPECTED_SUBMIT");
  expect(events).toEqual(["created", "stage", "accepted"]);
  expect(created.mock.calls[0]?.[0]).toEqual({
    requestId: submit.submission.requestId,
    ownerId: f.controller.ownerId,
    scope: null,
  });
  expect(accepted).toHaveBeenCalledWith(
    created.mock.calls[0]?.[0],
    expect.objectContaining({ id, ownerId: f.controller.ownerId }),
  );
  await f.controller.dispose();
});
it("passes one request intent through reuse miss and actual submit and retires reuse hit/failure/cancel/dispose", async () => {
  const created = vi.fn(),
    retired = vi.fn(),
    cancelled = vi.fn(),
    disposed = vi.fn(),
    failedJob = vi.fn(),
    f = fixture({ created, retired, cancelled, disposed, failedJob });
  f.port.tryReuse = vi.fn(async () => false);
  const command = {
    type: "SUBMIT_YOUTUBE" as const,
    url: "https://youtu.be/abcdefghijk",
    rightsConfirmed: true as const,
    trimEnabled: false,
  };
  await f.controller.execute(command, "window");
  const submit = f.commands[0]!;
  if (submit.action !== "submit") throw new Error("EXPECTED_SUBMIT");
  expect(f.port.tryReuse).toHaveBeenCalledWith(
    expect.objectContaining({ requestId: submit.submission.requestId }),
    expect.any(AbortSignal),
  );
  f.emit([{ ...f.job(f.controller.ownerId), state: "failed" }]);
  expect(failedJob).toHaveBeenCalledWith(f.controller.ownerId, id);
  await f.controller.execute({ type: "CANCEL", jobId: id }, "window");
  expect(cancelled).toHaveBeenCalledWith(f.controller.ownerId, id);
  f.port.tryReuse = vi.fn(async () => true);
  await f.controller.execute(command, "window");
  expect(retired).toHaveBeenCalledWith(
    created.mock.calls.at(-1)?.[0],
    "reused",
  );
  f.port.tryReuse = vi.fn(async () => {
    throw new Error("SOURCE_UNAVAILABLE");
  });
  await f.controller.execute(command, "window");
  expect(retired).toHaveBeenCalledWith(
    created.mock.calls.at(-1)?.[0],
    "failed",
  );
  await f.controller.dispose();
  expect(disposed).toHaveBeenCalledWith(f.controller.ownerId);
});
it("mints the desktop owner/request and runs signed-out file work with an opaque staged capability", async () => {
  const f = fixture();
  await f.controller.execute(
    {
      type: "SUBMIT_FILE",
      capability: id,
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window-1",
  );
  expect(f.port.stage).toHaveBeenCalledWith(
    id,
    "window-1",
    f.controller.ownerId,
    null,
    expect.any(AbortSignal),
  );
  const submit = f.commands[0]!;
  expect(submit.action).toBe("submit");
  if (submit.action === "submit")
    expect(submit.submission).toMatchObject({
      ownerId: f.controller.ownerId,
      input: { kind: "file", capability: id },
      recipeId: "kim-vocals-v2",
      rightsConfirmed: true,
    });
  expect(f.controller.view()).toMatchObject({ connected: true, busy: true });
  await f.controller.dispose();
});
it("does not submit a staged file after its captured account generation changes", async () => {
  const f = fixture();
  f.setScope({ firebaseUid: "A", generation: id });
  f.port.stage = vi.fn(async () => {
    f.setScope({ firebaseUid: "B", generation: id });
    return id;
  });
  expect(
    await f.controller.execute(
      {
        type: "SUBMIT_FILE",
        capability: id,
        rightsConfirmed: true,
        trimEnabled: false,
      },
      "window-1",
    ),
  ).toMatchObject({ error: "SCOPE_CHANGED", busy: false });
  expect(f.commands).toHaveLength(0);
  await f.controller.dispose();
});
it("keeps a guest staged-file intake alive on login and sends its original null capture to dispatch", async () => {
  const created = vi.fn(),
    accepted = vi.fn(),
    f = fixture({ created, accepted });
  let ready!: (capability: string) => void, signal: AbortSignal | undefined;
  f.port.stage = vi.fn(
    async (_capability, _window, _owner, _scope, selectedSignal) => {
      signal = selectedSignal;
      return new Promise<string>((resolve) => {
        ready = resolve;
      });
    },
  );
  const pending = f.controller.execute(
    {
      type: "SUBMIT_FILE",
      capability: id,
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  await vi.waitFor(() => expect(ready).toBeDefined());
  const account = { firebaseUid: "A", generation: id };
  f.setScope(account);
  f.controller.scopeChanging(account);
  expect(signal?.aborted).toBe(false);
  ready(id);
  await pending;
  expect(f.port.command).toHaveBeenCalledWith(
    expect.objectContaining({ action: "submit" }),
    null,
  );
  expect(created.mock.calls[0]?.[0].scope).toBeNull();
  expect(accepted.mock.calls[0]?.[0].scope).toBeNull();
  expect(f.controller.view()).toMatchObject({ busy: true, error: null });
  await f.controller.dispose();
});
it("retains null through a guest YouTube reuse miss during login without granting account capture", async () => {
  const f = fixture();
  let ready!: (hit: boolean) => void, signal: AbortSignal | undefined;
  f.port.tryReuse = vi.fn(async (_request, selectedSignal) => {
    signal = selectedSignal;
    return new Promise<boolean>((resolve) => {
      ready = resolve;
    });
  });
  const pending = f.controller.execute(
    {
      type: "SUBMIT_YOUTUBE",
      url: "https://youtu.be/abcdefghijk",
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  await vi.waitFor(() => expect(ready).toBeDefined());
  const account = { firebaseUid: "A", generation: id };
  f.setScope(account);
  f.controller.scopeChanging(account);
  expect(signal?.aborted).toBe(false);
  ready(false);
  await pending;
  expect(f.port.tryReuse).toHaveBeenCalledWith(
    expect.objectContaining({ scope: null }),
    expect.any(AbortSignal),
  );
  expect(f.port.command).toHaveBeenCalledWith(
    expect.objectContaining({ action: "submit" }),
    null,
  );
  expect(f.controller.view().error).toBeNull();
  await f.controller.dispose();
});
it("aborts only account-A intake on A to B and reports the original authority retirement even when staging ignores cancellation", async () => {
  const retired = vi.fn(),
    f = fixture({ retired });
  const accountA = { firebaseUid: "A", generation: id },
    accountB = { firebaseUid: "B", generation: id };
  f.setScope(accountA);
  let ready!: (capability: string) => void, signal: AbortSignal | undefined;
  f.port.stage = vi.fn(
    async (_capability, _window, _owner, _scope, selectedSignal) => {
      signal = selectedSignal;
      return new Promise<string>((resolve) => {
        ready = resolve;
      });
    },
  );
  const pending = f.controller.execute(
    {
      type: "SUBMIT_FILE",
      capability: id,
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  await vi.waitFor(() => expect(ready).toBeDefined());
  f.setScope(accountB);
  f.controller.scopeChanging(accountB);
  expect(signal?.aborted).toBe(true);
  ready(id);
  await pending;
  expect(f.commands).toHaveLength(0);
  expect(f.controller.view()).toMatchObject({
    busy: false,
    error: "SCOPE_CHANGED",
  });
  expect(retired).toHaveBeenCalledWith(
    expect.objectContaining({ scope: accountA }),
    "scope-changed",
  );
  await f.controller.dispose();
});
it("restarts the owner event subscription only after the current scope is acknowledged and ignores old snapshot delivery", async () => {
  const f = fixture(),
    accountA = { firebaseUid: "A", generation: id },
    accountB = { firebaseUid: "B", generation: id };
  f.setScope(accountA);
  const lanes: {
    notify: (jobs: PersonalJobView[]) => void;
    signal: AbortSignal;
    fail: (reason: Error) => void;
  }[] = [];
  f.port.watch = vi.fn(
    async (_owner, notify, signal) =>
      new Promise<void>((_done, fail) => {
        lanes.push({ notify, signal, fail });
        signal.addEventListener(
          "abort",
          () => fail(new Error("SCOPE_CHANGED")),
          { once: true },
        );
      }),
  );
  await f.controller.execute(
    {
      type: "SUBMIT_YOUTUBE",
      url: "https://youtu.be/abcdefghijk",
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  expect(lanes).toHaveLength(1);
  f.setScope(accountB);
  f.controller.scopeChanging(accountB);
  f.controller.scopeChanged(accountA);
  expect(lanes).toHaveLength(1);
  f.controller.scopeChanged(accountB);
  expect(lanes).toHaveLength(2);
  expect(lanes[0]!.signal.aborted).toBe(true);
  lanes[0]!.notify([{ ...f.job(f.controller.ownerId), name: "Account A old" }]);
  lanes[1]!.notify([
    { ...f.job(f.controller.ownerId), name: "Guest continues", state: "ready" },
  ]);
  await Promise.resolve();
  expect(f.controller.view()).toMatchObject({
    connected: true,
    busy: false,
    error: null,
    jobs: [expect.objectContaining({ name: "Guest continues" })],
  });
  await f.controller.dispose();
});
it("acknowledges an initially disconnected scope without creating an unregistered owner watcher", async () => {
  const f = fixture();
  expect(f.controller.view().connected).toBe(false);
  f.controller.scopeChanging(null);
  f.controller.scopeChanged(null);
  expect(f.controller.view()).toMatchObject({ connected: true, error: null });
  expect(f.port.watch).not.toHaveBeenCalled();
  await f.controller.dispose();
});
it("cancels an exact pending request and awaits the copier's cleanup before replying", async () => {
  const created = vi.fn(),
    f = fixture({ created });
  let cleanup!: () => void, signal: AbortSignal | undefined;
  f.port.stage = vi.fn(
    async (_cap, _window, _owner, _scope, selectedSignal) => {
      signal = selectedSignal;
      await new Promise<void>((resolve) => {
        cleanup = resolve;
      });
      selectedSignal.throwIfAborted();
      return id;
    },
  );
  const submitting = f.controller.execute(
    {
      type: "SUBMIT_FILE",
      capability: id,
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  await vi.waitFor(() => expect(cleanup).toBeDefined());
  const requestId = created.mock.calls[0]![0].requestId;
  let settled = false;
  const cancelling = f.controller
    .execute({ type: "CANCEL_REQUEST", requestId }, "window")
    .then((value) => {
      settled = true;
      return value;
    });
  await Promise.resolve();
  expect(signal?.aborted).toBe(true);
  expect(settled).toBe(false);
  expect(f.controller.view().busy).toBe(true);
  cleanup();
  await submitting;
  expect(await cancelling).toMatchObject({ busy: false, error: "CANCELLED" });
  expect(f.commands).toEqual([]);
  await f.controller.dispose();
});
it("cancels the exact owned late job acknowledgement and awaits actual cleanup instead of orphaning submission", async () => {
  const created = vi.fn(),
    accepted = vi.fn(),
    f = fixture({ created, accepted });
  let acknowledge!: () => void, cleanup!: () => void;
  const commands: PersonalCommand[] = [];
  f.port.command = vi.fn(
    async (command: PersonalCommand): Promise<PersonalReply> => {
      commands.push(command);
      if (command.action === "submit") {
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
        return {
          version: 1,
          requestId: command.requestId,
          ok: true,
          job: f.job(f.controller.ownerId),
        };
      }
      if (command.action === "cancel")
        await new Promise<void>((resolve) => {
          cleanup = resolve;
        });
      return { version: 1, requestId: command.requestId, ok: true, jobs: [] };
    },
  );
  const submitting = f.controller.execute(
    {
      type: "SUBMIT_YOUTUBE",
      url: "https://youtu.be/abcdefghijk",
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  await vi.waitFor(() => expect(acknowledge).toBeDefined());
  let settled = false;
  const cancelling = f.controller
    .execute(
      {
        type: "CANCEL_REQUEST",
        requestId: created.mock.calls[0]![0].requestId,
      },
      "window",
    )
    .then((value) => {
      settled = true;
      return value;
    });
  acknowledge();
  await vi.waitFor(() => expect(cleanup).toBeDefined());
  expect(commands[1]).toMatchObject({
    action: "cancel",
    ownerId: f.controller.ownerId,
    jobId: id,
  });
  expect(settled).toBe(false);
  expect(f.controller.view().busy).toBe(true);
  cleanup();
  await submitting;
  expect(await cancelling).toMatchObject({
    busy: false,
    jobs: [],
    error: "CANCELLED",
  });
  expect(accepted).not.toHaveBeenCalled();
  await f.controller.dispose();
});
it.each([false, true])(
  "retains late-job STOP_UNCONFIRMED until positive exact cleanup proof (retry=%s)",
  async (retry) => {
    const created = vi.fn(),
      f = fixture({ created });
    let acknowledge!: () => void;
    f.port.command = vi.fn(
      async (command: PersonalCommand): Promise<PersonalReply> => {
        if (command.action === "submit") {
          await new Promise<void>((resolve) => {
            acknowledge = resolve;
          });
          return {
            version: 1,
            requestId: command.requestId,
            ok: true,
            job: f.job(f.controller.ownerId),
          };
        }
        return {
          version: 1,
          requestId: command.requestId,
          ok: false,
          error: "STOP_UNCONFIRMED",
        };
      },
    );
    const submitting = f.controller.execute(
      {
        type: "SUBMIT_YOUTUBE",
        url: "https://youtu.be/abcdefghijk",
        rightsConfirmed: true,
        trimEnabled: false,
      },
      "window",
    );
    await vi.waitFor(() => expect(acknowledge).toBeDefined());
    const cancellation = f.controller.execute(
      {
        type: "CANCEL_REQUEST",
        requestId: created.mock.calls[0]![0].requestId,
      },
      "window",
    );
    const refused = expect(cancellation).rejects.toThrow("STOP_UNCONFIRMED");
    acknowledge();
    expect(await submitting).toMatchObject({
      busy: true,
      error: "STOP_UNCONFIRMED",
      jobs: [expect.objectContaining({ id, error: "STOP_UNCONFIRMED" })],
    });
    expect(f.port.watch).toHaveBeenCalledOnce();
    await refused;
    if (retry) {
      f.port.command = vi.fn(
        async (command: PersonalCommand): Promise<PersonalReply> => ({
          version: 1,
          requestId: command.requestId,
          ok: true,
          jobs: [],
        }),
      );
      await f.controller.execute({ type: "CANCEL", jobId: id }, "window");
      expect(f.controller.view()).toMatchObject({ busy: false, jobs: [] });
      await f.controller.dispose();
    } else
      await expect(f.controller.dispose()).rejects.toThrow("STOP_UNCONFIRMED");
  },
);
it("keeps a failed STOP_UNCONFIRMED tree busy across empty account-filtered snapshots until a genuine exact cleanup acknowledgement", async () => {
  const f = fixture();
  await f.controller.execute(
    {
      type: "SUBMIT_YOUTUBE",
      url: "https://youtu.be/abcdefghijk",
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  const failed: PersonalJobView = {
    ...f.job(f.controller.ownerId),
    state: "failed",
    error: "STOP_UNCONFIRMED",
  };
  f.emit([failed]);
  expect(f.controller.view()).toMatchObject({ busy: true, jobs: [failed] });
  const account = { firebaseUid: "A", generation: id };
  f.setScope(account);
  f.controller.scopeChanging(account);
  f.controller.scopeChanged(account);
  f.emit([]);
  expect(f.controller.view()).toMatchObject({ busy: true, jobs: [] });
  // The protected activity remains, while stale account rows stay hidden.
  f.emit([failed]);
  await f.controller.execute({ type: "CANCEL", jobId: id }, "window");
  expect(f.commands.at(-1)).toMatchObject({
    action: "cancel",
    ownerId: f.controller.ownerId,
    jobId: id,
  });
  expect(f.controller.view()).toMatchObject({ busy: false, jobs: [] });
  await f.controller.dispose();
});
it("retains the exact owned terminal job and restarts its event watch when a cancel ACK is lost", async () => {
  const f = fixture();
  await f.controller.execute(
    {
      type: "SUBMIT_YOUTUBE",
      url: "https://youtu.be/abcdefghijk",
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  f.emit([{ ...f.job(f.controller.ownerId), state: "failed" }]);
  expect(f.controller.view().busy).toBe(false);
  const successful = f.port.command;
  f.port.command = vi.fn(
    async (command: PersonalCommand): Promise<PersonalReply> => {
      if (command.action === "cancel") throw new Error("PIPE_TIMEOUT");
      return successful(command);
    },
  );
  await expect(
    f.controller.execute({ type: "CANCEL", jobId: id }, "window"),
  ).rejects.toThrow("STOP_UNCONFIRMED");
  expect(f.port.watch).toHaveBeenCalledTimes(2);
  expect(f.controller.view()).toMatchObject({
    busy: true,
    error: "STOP_UNCONFIRMED",
    jobs: [
      expect.objectContaining({
        id,
        state: "failed",
        error: "STOP_UNCONFIRMED",
      }),
    ],
  });
  f.emit([]);
  expect(f.controller.view().busy).toBe(true);
  await f.controller.cancelOwnedWork();
  expect(f.controller.view()).toMatchObject({ busy: false, jobs: [] });
  await f.controller.dispose();
});
it("does not resume a detached owner's watcher when a later account scope is acknowledged", async () => {
  const f = fixture();
  await f.controller.execute(
    {
      type: "SUBMIT_YOUTUBE",
      url: "https://youtu.be/abcdefghijk",
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  expect(f.port.watch).toHaveBeenCalledTimes(1);
  await f.controller.cancelOwnedWork();
  f.controller.scopeChanged(null);
  expect(f.port.watch).toHaveBeenCalledTimes(1);
  expect(f.controller.view().jobs).toEqual([]);
  await f.controller.dispose();
});
it("accepts a canonical YouTube link, keeps untrimmed default and never silently redirects to cloud", async () => {
  const f = fixture();
  await f.controller.execute(
    {
      type: "SUBMIT_YOUTUBE",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  const submit = f.commands[0]!;
  if (submit.action !== "submit") throw new Error("EXPECTED_SUBMIT");
  expect(submit.submission.input).toEqual({
    kind: "youtube",
    videoId: "abcdefghijk",
  });
  expect(f.port.stage).not.toHaveBeenCalled();
  await f.controller.dispose();
});
it("uses owned event snapshots and ignores foreign owners before exposing safe progress", async () => {
  const f = fixture();
  await f.controller.execute(
    {
      type: "SUBMIT_YOUTUBE",
      url: "https://youtu.be/abcdefghijk",
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  f.emit([
    { ...f.job("foreign"), name: "Other owner" },
    { ...f.job(f.controller.ownerId), state: "ready", progress: 100 },
  ]);
  expect(f.controller.view().jobs).toHaveLength(1);
  expect(f.controller.view().busy).toBe(false);
  await f.controller.dispose();
});
it("personal quit detaches the exact owned scope and preserves an ambiguous-stop busy state", async () => {
  const f = fixture();
  await f.controller.execute(
    {
      type: "SUBMIT_YOUTUBE",
      url: "https://youtu.be/abcdefghijk",
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  const working = f.port.command;
  f.port.command = async (command) => {
    if (command.action === "detach")
      return {
        version: 1,
        requestId: command.requestId,
        ok: false,
        error: "STOP_UNCONFIRMED",
      };
    return working(command);
  };
  await expect(f.controller.cancelOwnedWork()).rejects.toThrow(
    "STOP_UNCONFIRMED",
  );
  expect(f.controller.view().busy).toBe(true);
  f.port.command = working;
  await f.controller.cancelOwnedWork();
  expect(f.commands.at(-1)).toMatchObject({
    action: "detach",
    ownerId: f.controller.ownerId,
  });
  expect(f.controller.view().busy).toBe(false);
  await f.controller.dispose();
});
it("requires rights confirmation and exposes fixed errors instead of private exception text", async () => {
  const f = fixture();
  await expect(
    f.controller.execute(
      {
        type: "SUBMIT_FILE",
        capability: id,
        rightsConfirmed: false as true,
        trimEnabled: false,
      },
      "window",
    ),
  ).rejects.toThrow("INVALID_REQUEST");
  f.port.stage = async () => {
    throw new Error("C:\\private\\fixture token=secret");
  };
  expect(
    await f.controller.execute(
      {
        type: "SUBMIT_FILE",
        capability: id,
        rightsConfirmed: true,
        trimEnabled: false,
      },
      "window",
    ),
  ).toMatchObject({ error: "PROCESSING_FAILED" });
  await f.controller.dispose();
});
it("unknown error code objects and accessors cannot execute coercion or disclose private errors", async () => {
  const f = fixture(),
    coercion = vi.fn(() => {
      throw new Error("private-code-coercion");
    }),
    getter = vi.fn(() => {
      throw new Error("private-error-getter");
    }),
    accessor = Object.defineProperties(new Error("untrusted-private-detail"), {
      code: { get: getter },
      name: { get: getter },
      message: { get: getter },
    });
  for (const error of [
    { code: { toString: coercion, [Symbol.toPrimitive]: coercion } },
    accessor,
    { code: 123 },
  ]) {
    f.port.stage = async () => {
      throw error;
    };
    expect(
      await f.controller.execute(
        {
          type: "SUBMIT_FILE",
          capability: id,
          rightsConfirmed: true,
          trimEnabled: false,
        },
        "window",
      ),
    ).toMatchObject({ error: "PROCESSING_FAILED", busy: false });
  }
  expect(coercion).not.toHaveBeenCalled();
  expect(getter).not.toHaveBeenCalled();
  f.port.stage = async () => {
    throw { code: "INPUT_CHANGED" };
  };
  expect(
    await f.controller.execute(
      {
        type: "SUBMIT_FILE",
        capability: id,
        rightsConfirmed: true,
        trimEnabled: false,
      },
      "window",
    ),
  ).toMatchObject({ error: "INPUT_CHANGED" });
  await f.controller.dispose();
});
it("uses a verified reuse hit without submitting inference or inventing a personal job", async () => {
  const f = fixture();
  f.port.tryReuse = vi.fn(async () => true);
  const view = await f.controller.execute(
    {
      type: "SUBMIT_YOUTUBE",
      url: "https://youtu.be/abcdefghijk",
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  expect(f.port.tryReuse).toHaveBeenCalledWith(
    expect.objectContaining({
      ownerId: f.controller.ownerId,
      videoId: "abcdefghijk",
      scope: null,
    }),
    expect.any(AbortSignal),
  );
  expect(f.commands).toHaveLength(0);
  expect(view).toMatchObject({ busy: false, jobs: [], error: null });
  await f.controller.dispose();
});
it("keeps trimmed processing out of full-timeline reuse and submits after a verified miss", async () => {
  const f = fixture();
  f.port.tryReuse = vi.fn(async () => false);
  await f.controller.execute(
    {
      type: "SUBMIT_YOUTUBE",
      url: "https://youtu.be/abcdefghijk",
      rightsConfirmed: true,
      trimEnabled: true,
    },
    "window",
  );
  expect(f.port.tryReuse).not.toHaveBeenCalled();
  expect(f.commands[0]).toMatchObject({
    action: "submit",
    submission: { recipeId: "kim-vocals-v2-trim" },
  });
  await f.controller.cancelOwnedWork();
  await f.controller.execute(
    {
      type: "SUBMIT_YOUTUBE",
      url: "https://youtu.be/abcdefghijk",
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  expect(f.port.tryReuse).toHaveBeenCalledTimes(1);
  expect(f.commands.at(-1)).toMatchObject({
    action: "submit",
    submission: { recipeId: "kim-vocals-v2" },
  });
  await f.controller.dispose();
});
it("does not start inference after owner changes during reuse lookup", async () => {
  const f = fixture();
  f.setScope({ firebaseUid: "A", generation: id });
  f.port.tryReuse = vi.fn(async () => {
    f.setScope({ firebaseUid: "B", generation: id });
    return false;
  });
  const view = await f.controller.execute(
    {
      type: "SUBMIT_YOUTUBE",
      url: "https://youtu.be/abcdefghijk",
      rightsConfirmed: true,
      trimEnabled: false,
    },
    "window",
  );
  expect(view).toMatchObject({ error: "SCOPE_CHANGED", busy: false });
  expect(f.commands).toHaveLength(0);
  await f.controller.dispose();
});
