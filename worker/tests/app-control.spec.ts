import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeAppControlCommand,
  safePayload,
  subscribeAppControl,
  type AppControlDependencies,
} from "../src/platform/macos/app-control.js";
import {
  APP_COMMANDS,
  type AppControlResponse,
} from "../src/platform/macos/app-control-protocol.js";
import { createMacUserLayout } from "../src/platform/macos/user-paths.js";
import type { MacUserCommandContext } from "../src/platform/macos/user-cli.js";
import { runOperatorCommand } from "../src/platform/shared/operator-cli.js";

const requestId = "7161b679-e633-4280-bbb5-831992549700";
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const frame = (
  command: string,
  parameters: Record<string, unknown> = {},
  type = "COMMAND",
) => ({
  protocol_version: 1,
  request_id: requestId,
  type,
  command,
  parameters,
});

describe("macOS app command facade", () => {
  it("dispatches every guarded operator capability without arbitrary CLI arguments", async () => {
    const runCommand = vi.fn(
      async (
        _command: string,
        _args: readonly string[],
        context: MacUserCommandContext = {},
      ) => {
        context.stdout?.(JSON.stringify({ status: "ok", installed: true }));
        return 0;
      },
    );
    for (const command of APP_COMMANDS.filter((item) => item !== "versions")) {
      const parameters =
        command === "install"
          ? { label: "Mac", enrollment_code: "secret" }
          : command === "job"
            ? { job_id: "0123456789abcdef01234567" }
            : command === "explain"
              ? { code: "AUDIO_DECODE_FAILED" }
              : command === "capacity"
                ? { workers: 1 }
                : command === "benchmark-file"
                  ? { input: "/tmp/input.wav" }
                  : {};
      const output: AppControlResponse[] = [];
      await executeAppControlCommand(
        frame(command, parameters),
        (value) => output.push(value),
        { runCommand },
      );
      expect(output).toEqual([
        {
          protocol_version: 1,
          request_id: requestId,
          type: "RESULT",
          payload: { status: "ok", installed: true },
        },
      ]);
    }
    expect(runCommand.mock.calls).toHaveLength(APP_COMMANDS.length - 1);
    expect(
      runCommand.mock.calls.every(
        ([, args, context]) =>
          args.includes("--json") && context?.appControl === true,
      ),
    ).toBe(true);
  });

  it("passes enrollment only to the private prompt replacement and removes it from replies", async () => {
    const output: AppControlResponse[] = [];
    await executeAppControlCommand(
      frame("install", { label: "Mac", enrollment_code: "very-private-code" }),
      (value) => output.push(value),
      {
        runCommand: async (_command, args, context = {}) => {
          expect(args.join(" ")).not.toContain("very-private-code");
          expect(await context.readEnrollmentCode?.()).toBe(
            "very-private-code",
          );
          context.stdout?.(
            JSON.stringify({
              status: "ok",
              credential: "machine-secret",
              nested: {
                enrollment_code: "very-private-code",
                note: "very-private-code",
              },
            }),
          );
          return 0;
        },
      },
    );
    expect(JSON.stringify(output)).not.toContain("very-private-code");
    expect(JSON.stringify(output)).not.toContain("machine-secret");
    expect(output[0]).toMatchObject({
      type: "RESULT",
      payload: { nested: { note: "[REDACTED]" } },
    });
  });

  it("uses a safe code for any raw dependency error", async () => {
    const output: AppControlResponse[] = [];
    await executeAppControlCommand(
      frame("install", { label: "Mac" }),
      (value) => output.push(value),
      {
        runCommand: async () => {
          throw new Error(
            "credential=super-secret https://private.example/thing",
          );
        },
      },
    );
    expect(output).toEqual([
      {
        protocol_version: 1,
        request_id: requestId,
        type: "ERROR",
        error_code: "OPERATION_FAILED",
      },
    ]);
  });

  it("preserves unhealthy status as a meaningful result and adoption never installs", async () => {
    const runCommand = vi.fn(
      async (_command, _args, context: MacUserCommandContext = {}) => {
        context.stdout?.('{"installed":true,"healthy":false}');
        return 1;
      },
    );
    const output: AppControlResponse[] = [];
    await executeAppControlCommand(
      frame("adopt"),
      (value) => output.push(value),
      { runCommand },
    );
    expect(runCommand.mock.calls[0]?.slice(0, 2)).toEqual([
      "status",
      ["--json", "--local"],
    ]);
    expect(output[0]).toMatchObject({
      type: "RESULT",
      payload: { healthy: false },
    });
  });

  it("separates progress and results and rejects invalid or repeated result output", async () => {
    const output: AppControlResponse[] = [];
    await executeAppControlCommand(
      frame("start", { wait_ready: true }),
      (value) => output.push(value),
      {
        runCommand: async (_command, _args, context = {}) => {
          context.stdout?.('{"type":"readiness-update","phase":"warming"}');
          context.stdout?.('{"status":"ok"}');
          return 0;
        },
      },
    );
    expect(output.map((item) => item.type)).toEqual(["PROGRESS", "RESULT"]);
    for (const lines of [
      ["raw stderr"],
      ["{}", "{}"],
      ["[]"],
      [JSON.stringify({ text: "x".repeat(4 * 1024 * 1024) })],
    ]) {
      const invalid: AppControlResponse[] = [];
      await executeAppControlCommand(
        frame("status"),
        (value) => invalid.push(value),
        {
          runCommand: async (_command, _args, context = {}) => {
            for (const line of lines) context.stdout?.(line);
            return 0;
          },
        },
      );
      expect(invalid[0]?.type).toBe("ERROR");
    }
  });

  it("redacts all untrusted log strings while keeping a diagnostic export revealable", async () => {
    expect(
      safePayload({
        stdout: "credential=secret https://private.example /Users/private/file",
      }),
    ).toEqual({
      stdout: "credential=[REDACTED] [REDACTED_URL] /Users/[REDACTED]/file",
    });
    const output: AppControlResponse[] = [];
    await executeAppControlCommand(
      frame("diagnostics"),
      (value) => output.push(value),
      {
        runCommand: async (_command, _args, context = {}) => {
          context.stdout?.(
            '{"path":"/Users/user/Worker diagnostics.zip","files":[]}',
          );
          return 0;
        },
      },
    );
    expect(output[0]).toMatchObject({
      payload: { path: "/Users/user/Worker diagnostics.zip" },
    });
  });
});

describe("file-published full snapshot subscriptions", () => {
  it("publishes complete filtered live logs after file and directory replacements, then releases watchers", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-app-logs-"));
    roots.push(root);
    await chmod(root, 0o700);
    const layout = createMacUserLayout(root);
    const directory = join(layout.workRoot, "..", "logs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const attemptId = "cb56441d-f2df-4b44-a320-6f37dfa81f7f";
    const publish = async (generation: number) => {
      const records = [
        {
          recordedAt: "2026-10-06T00:00:00.000Z",
          event: {
            kind: "attempt-failed",
            attemptId,
            code: `FILTERED_${generation}`,
            message: "credential=fixture-secret",
          },
        },
        {
          recordedAt: "2026-10-06T00:00:00.000Z",
          event: { kind: "started", attemptId },
        },
        {
          recordedAt: "2026-10-06T00:00:00.000Z",
          event: {
            kind: "attempt-failed",
            attemptId: requestId,
            code: "OTHER_ATTEMPT",
          },
        },
      ];
      await writeFile(
        join(directory, "events.jsonl.tmp"),
        records.map((value) => JSON.stringify(value)).join("\n") + "\n",
        { mode: 0o600 },
      );
      await rename(
        join(directory, "events.jsonl.tmp"),
        join(directory, "events.jsonl"),
      );
    };
    await publish(1);
    const output: AppControlResponse[] = [];
    const controller = new AbortController();
    const runCommand = vi.fn(
      async (
        command: string,
        arguments_: readonly string[],
        context: MacUserCommandContext = {},
      ) => runOperatorCommand(command, arguments_, layout, context),
    );
    const running = subscribeAppControl(
      frame(
        "logs",
        { events: true, attempt_id: attemptId, level: "error", lines: 3 },
        "SUBSCRIBE",
      ),
      (value) => output.push(value),
      controller.signal,
      { context: { layout }, runCommand },
    );
    const snapshot = (generation: number) =>
      output.find(
        (value) =>
          value.type === "SNAPSHOT" &&
          JSON.stringify(value.payload).includes(`FILTERED_${generation}`),
      );
    try {
      await until(() => !!snapshot(1), output);
      await publish(2);
      await until(() => !!snapshot(2), output);
      await rename(directory, `${directory}-previous`);
      await mkdir(directory, { mode: 0o700 });
      await publish(3);
      await until(() => !!snapshot(3), output);
      expect(snapshot(3)).toMatchObject({
        type: "SNAPSHOT",
        payload: {
          events: [
            { level: "error", event: { attemptId, code: "FILTERED_3" } },
          ],
        },
      });
      for (const value of output.filter((value) => value.type === "SNAPSHOT"))
        if (value.type === "SNAPSHOT")
          expect(
            (value.payload.events as unknown[]).length,
          ).toBeLessThanOrEqual(1);
      expect(JSON.stringify(output)).not.toContain("fixture-secret");
      expect(JSON.stringify(output)).not.toContain("OTHER_ATTEMPT");
      await new Promise((resolve) => setTimeout(resolve, 150));
      const calls = runCommand.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(runCommand.mock.calls.length).toBe(calls);
    } finally {
      controller.abort();
      await running;
    }
    const calls = runCommand.mock.calls.length;
    await publish(4);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runCommand.mock.calls.length).toBe(calls);
  }, 20_000);

  it("emits an initial snapshot and replacement snapshots, without a remote call or timers polling status", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-app-control-"));
    roots.push(root);
    await chmod(root, 0o700);
    const layout = createMacUserLayout(root);
    await mkdir(layout.stateRoot, { recursive: true, mode: 0o700 });
    await writeFile(layout.runtimeStatusPath, '{"generation":1}', {
      mode: 0o600,
    });
    const runCommand = vi.fn(
      async (_command, args, context: MacUserCommandContext = {}) => {
        expect(args).toEqual(["--json", "--local"]);
        context.stdout?.(await readFile(layout.runtimeStatusPath, "utf8"));
        return 0;
      },
    );
    const output: AppControlResponse[] = [];
    const controller = new AbortController();
    const running = subscribeAppControl(
      frame("status", {}, "SUBSCRIBE"),
      (value) => output.push(value),
      controller.signal,
      { context: { layout }, runCommand },
    );
    try {
      await until(() => output.length === 1, output);
      await writeFile(`${layout.runtimeStatusPath}.tmp`, '{"generation":2}', {
        mode: 0o600,
      });
      await rename(`${layout.runtimeStatusPath}.tmp`, layout.runtimeStatusPath);
      await until(() => output.length === 2, output);
      expect(output).toMatchObject([
        { type: "SNAPSHOT", payload: { generation: 1 } },
        { type: "SNAPSHOT", payload: { generation: 2 } },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const calls = runCommand.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(runCommand.mock.calls.length).toBe(calls);
    } finally {
      controller.abort();
      await running;
    }
    const calls = runCommand.mock.calls.length;
    await writeFile(layout.runtimeStatusPath, '{"generation":3}', {
      mode: 0o600,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runCommand.mock.calls.length).toBe(calls);
  });

  it("watches missing installation ancestors, then adopts newly published state", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-app-control-"));
    roots.push(root);
    await chmod(root, 0o700);
    const layout = createMacUserLayout(root);
    let installed = false;
    const output: AppControlResponse[] = [];
    const controller = new AbortController();
    const running = subscribeAppControl(
      frame("status", {}, "SUBSCRIBE"),
      (value) => output.push(value),
      controller.signal,
      {
        context: { layout },
        runCommand: async (_command, _args, context = {}) => {
          context.stdout?.(JSON.stringify({ installed }));
          return 0;
        },
      },
    );
    try {
      await until(() => output.length === 1, output);
      installed = true;
      await mkdir(layout.stateRoot, { recursive: true, mode: 0o700 });
      await writeFile(layout.runtimeStatusPath, "{}", { mode: 0o600 });
      await until(() => output.length === 2, output);
      expect(output[1]).toMatchObject({ payload: { installed: true } });
    } finally {
      controller.abort();
      await running;
    }
  });

  it("rebinds a replaced state directory and observes later publications in the new inode", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-app-control-"));
    roots.push(root);
    await chmod(root, 0o700);
    const layout = createMacUserLayout(root);
    await mkdir(layout.stateRoot, { recursive: true, mode: 0o700 });
    await writeFile(layout.runtimeStatusPath, '{"generation":1}', {
      mode: 0o600,
    });
    const output: AppControlResponse[] = [];
    const controller = new AbortController();
    const running = subscribeAppControl(
      frame("status", {}, "SUBSCRIBE"),
      (value) => output.push(value),
      controller.signal,
      {
        context: { layout },
        runCommand: async (_command, _args, context = {}) => {
          context.stdout?.(await readFile(layout.runtimeStatusPath, "utf8"));
          return 0;
        },
      },
    );
    try {
      await until(() => output.length === 1, output);
      await rename(layout.stateRoot, `${layout.stateRoot}-previous`);
      await mkdir(layout.stateRoot, { mode: 0o700 });
      await writeFile(layout.runtimeStatusPath, '{"generation":2}', {
        mode: 0o600,
      });
      await until(() => output.length === 2, output);
      await writeFile(layout.runtimeStatusPath, '{"generation":3}', {
        mode: 0o600,
      });
      await until(() => output.length === 3, output);
      expect(output[2]).toMatchObject({
        type: "SNAPSHOT",
        payload: { generation: 3 },
      });
    } finally {
      controller.abort();
      await running;
    }
  });

  it("fails closed and releases watchers when local snapshot publication fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-app-control-"));
    roots.push(root);
    await chmod(root, 0o700);
    const layout = createMacUserLayout(root);
    const close = vi.fn();
    const output: AppControlResponse[] = [];
    await subscribeAppControl(
      frame("status", {}, "SUBSCRIBE"),
      (value) => output.push(value),
      new AbortController().signal,
      {
        context: { layout },
        watchDirectory: () => ({ close }),
        runCommand: async () => {
          throw new Error("private detail");
        },
      },
    );
    expect(output).toEqual([
      {
        protocol_version: 1,
        request_id: requestId,
        type: "ERROR",
        error_code: "SUBSCRIPTION_FAILED",
      },
    ]);
    expect(close).toHaveBeenCalled();
  });

  it("does not recreate watchers or read a snapshot when an in-flight directory stat completes after abort", async () => {
    vi.useFakeTimers();
    const fixture = await subscriptionFixture();
    const statStarted = deferred();
    const releaseStat = deferred();
    let replacing = false;
    fixture.statDirectory.mockImplementation(async (path) => {
      if (replacing && path === fixture.layout.stateRoot) {
        statStarted.resolve();
        await releaseStat.promise;
        return directoryInfo(2);
      }
      return directoryInfo();
    });
    const running = fixture.start();
    try {
      await fixture.initialSnapshot.promise;
      const stateWatcher = fixture.watches.find(
        (entry) => entry.path === fixture.layout.stateRoot,
      );
      expect(stateWatcher).toBeDefined();
      replacing = true;
      stateWatcher!.onChange();
      vi.advanceTimersByTime(50);
      await statStarted.promise;
      const watcherCount = fixture.watchDirectory.mock.calls.length;

      fixture.controller.abort();
      await running;
      for (const watcher of fixture.watches)
        expect(watcher.close).toHaveBeenCalledExactlyOnceWith();
      releaseStat.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(fixture.watchDirectory).toHaveBeenCalledTimes(watcherCount);
      expect(fixture.runCommand).toHaveBeenCalledTimes(1);
      expect(fixture.output).toMatchObject([
        { type: "SNAPSHOT", payload: { generation: 1 } },
      ]);
      for (const watcher of fixture.watches)
        expect(watcher.close).toHaveBeenCalledExactlyOnceWith();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseStat.resolve();
      fixture.controller.abort();
      await running;
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it.each(["ENOENT", "ENOTDIR"])(
    "recovers a directory replacement that throws %s between stat and watcher creation",
    async (code) => {
      vi.useFakeTimers();
      const fixture = await subscriptionFixture();
      let stateInode = 1;
      fixture.statDirectory.mockImplementation(async (path) =>
        directoryInfo(path === fixture.layout.stateRoot ? stateInode : 1),
      );
      const createWatcher = fixture.watchDirectory.getMockImplementation()!;
      let failNextStateWatcher = false;
      fixture.watchDirectory.mockImplementation((path, onChange, onError) => {
        if (path === fixture.layout.stateRoot && failNextStateWatcher) {
          failNextStateWatcher = false;
          throw Object.assign(new Error("directory replaced"), { code });
        }
        return createWatcher(path, onChange, onError);
      });
      const running = fixture.start();
      try {
        await fixture.initialSnapshot.promise;
        const stateWatcher = fixture.watches.find(
          (entry) => entry.path === fixture.layout.stateRoot,
        );
        expect(stateWatcher).toBeDefined();
        stateInode = 2;
        fixture.payload.generation = 2;
        failNextStateWatcher = true;
        stateWatcher!.onChange();
        await vi.advanceTimersByTimeAsync(50);

        expect(stateWatcher!.close).toHaveBeenCalledExactlyOnceWith();
        expect(fixture.output).toMatchObject([
          { type: "SNAPSHOT", payload: { generation: 1 } },
          { type: "SNAPSHOT", payload: { generation: 2 } },
        ]);
        await vi.advanceTimersByTimeAsync(50);
        const replacement = fixture.watches.findLast(
          (entry) => entry.path === fixture.layout.stateRoot,
        );
        expect(replacement).toBeDefined();
        expect(replacement).not.toBe(stateWatcher);
        expect(replacement!.close).not.toHaveBeenCalled();
        expect(
          fixture.watchDirectory.mock.calls.filter(
            ([path]) => path === fixture.layout.stateRoot,
          ),
        ).toHaveLength(3);

        fixture.payload.generation = 3;
        replacement!.onChange();
        await vi.advanceTimersByTimeAsync(50);
        expect(fixture.output).toMatchObject([
          { type: "SNAPSHOT", payload: { generation: 1 } },
          { type: "SNAPSHOT", payload: { generation: 2 } },
          { type: "SNAPSHOT", payload: { generation: 3 } },
        ]);
        expect(fixture.output.some((value) => value.type === "ERROR")).toBe(
          false,
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        fixture.controller.abort();
        await running;
      }
      for (const watcher of fixture.watches)
        expect(watcher.close).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it("ignores an old watcher's delayed error after rebinding the directory inode", async () => {
    vi.useFakeTimers();
    const fixture = await subscriptionFixture();
    let stateInode = 1;
    fixture.statDirectory.mockImplementation(async (path) =>
      directoryInfo(path === fixture.layout.stateRoot ? stateInode : 1),
    );
    const running = fixture.start();
    try {
      await fixture.initialSnapshot.promise;
      const oldWatcher = fixture.watches.find(
        (entry) => entry.path === fixture.layout.stateRoot,
      );
      expect(oldWatcher).toBeDefined();
      stateInode = 2;
      fixture.payload.generation = 2;
      oldWatcher!.onChange();
      await vi.advanceTimersByTimeAsync(50);
      const replacement = fixture.watches.findLast(
        (entry) => entry.path === fixture.layout.stateRoot,
      );
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(oldWatcher);

      const reads = fixture.runCommand.mock.calls.length;
      oldWatcher!.onError();
      await vi.advanceTimersByTimeAsync(50);
      expect(oldWatcher!.close).toHaveBeenCalledExactlyOnceWith();
      expect(replacement!.close).not.toHaveBeenCalled();
      expect(fixture.runCommand).toHaveBeenCalledTimes(reads);

      fixture.payload.generation = 3;
      replacement!.onChange();
      await vi.advanceTimersByTimeAsync(50);
      expect(fixture.output).toMatchObject([
        { type: "SNAPSHOT", payload: { generation: 1 } },
        { type: "SNAPSHOT", payload: { generation: 2 } },
        { type: "SNAPSHOT", payload: { generation: 3 } },
      ]);
      expect(replacement!.close).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fixture.controller.abort();
      await running;
    }
    for (const watcher of fixture.watches)
      expect(watcher.close).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(["EACCES", "EPERM"])(
    "fails closed and releases existing watchers when watcher creation reports %s",
    async (code) => {
      const fixture = await subscriptionFixture();
      const createWatcher = fixture.watchDirectory.getMockImplementation()!;
      fixture.watchDirectory.mockImplementation((path, onChange, onError) => {
        if (path === fixture.layout.stateRoot)
          throw Object.assign(new Error("private permission detail"), {
            code,
          });
        return createWatcher(path, onChange, onError);
      });
      await fixture.start();
      expect(fixture.output).toEqual([
        {
          protocol_version: 1,
          request_id: requestId,
          type: "ERROR",
          error_code: "SUBSCRIPTION_FAILED",
        },
      ]);
      expect(fixture.runCommand).not.toHaveBeenCalled();
      expect(fixture.watches.length).toBeGreaterThan(0);
      for (const watcher of fixture.watches)
        expect(watcher.close).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it.each(["non-directory", "symlink"])(
    "fails closed and releases existing watchers for a %s state path",
    async (kind) => {
      const fixture = await subscriptionFixture();
      fixture.statDirectory.mockImplementation(async (path) => ({
        ...directoryInfo(),
        isDirectory: () =>
          path !== fixture.layout.stateRoot || kind !== "non-directory",
        isSymbolicLink: () =>
          path === fixture.layout.stateRoot && kind === "symlink",
      }));
      await fixture.start();
      expect(fixture.output).toEqual([
        {
          protocol_version: 1,
          request_id: requestId,
          type: "ERROR",
          error_code: "SUBSCRIPTION_FAILED",
        },
      ]);
      expect(fixture.runCommand).not.toHaveBeenCalled();
      expect(
        fixture.watchDirectory.mock.calls.some(
          ([path]) => path === fixture.layout.stateRoot,
        ),
      ).toBe(false);
      expect(fixture.watches.length).toBeGreaterThan(0);
      for (const watcher of fixture.watches)
        expect(watcher.close).toHaveBeenCalledExactlyOnceWith();
    },
  );
});

async function until(
  predicate: () => boolean,
  output: readonly AppControlResponse[],
): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const failure = output.find((value) => value.type === "ERROR");
    if (failure?.type === "ERROR")
      throw new Error(`subscription terminated: ${failure.error_code}`);
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("snapshot did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function directoryInfo(inode = 1) {
  return {
    dev: 1,
    ino: inode,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

async function subscriptionFixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-app-control-race-"));
  roots.push(root);
  await chmod(root, 0o700);
  const layout = createMacUserLayout(root);
  const controller = new AbortController();
  const output: AppControlResponse[] = [];
  const initialSnapshot = deferred();
  const payload = { generation: 1 };
  const watches: {
    path: string;
    onChange(): void;
    onError(): void;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const statDirectory = vi.fn(async (_path: string) => directoryInfo());
  const watchDirectory = vi.fn(
    (path: string, onChange: () => void, onError: () => void) => {
      const watcher = { path, onChange, onError, close: vi.fn() };
      watches.push(watcher);
      return watcher;
    },
  );
  const runCommand = vi.fn(
    async (
      _command: string,
      _args: readonly string[],
      context: MacUserCommandContext = {},
    ) => {
      context.stdout?.(JSON.stringify(payload));
      return 0;
    },
  );
  const dependencies = {
    context: { layout },
    statDirectory,
    watchDirectory,
    runCommand,
  } satisfies AppControlDependencies;
  const start = () =>
    subscribeAppControl(
      frame("status", {}, "SUBSCRIBE"),
      (value) => {
        output.push(value);
        if (value.type === "SNAPSHOT") initialSnapshot.resolve();
      },
      controller.signal,
      dependencies,
    );
  return {
    layout,
    controller,
    output,
    initialSnapshot,
    payload,
    watches,
    statDirectory,
    watchDirectory,
    runCommand,
    start,
  };
}
