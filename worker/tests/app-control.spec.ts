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
      await until(() => !!snapshot(1));
      await publish(2);
      await until(() => !!snapshot(2));
      await rename(directory, `${directory}-previous`);
      await mkdir(directory, { mode: 0o700 });
      await publish(3);
      await until(() => !!snapshot(3));
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
  });

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
      await until(() => output.length === 1);
      await writeFile(`${layout.runtimeStatusPath}.tmp`, '{"generation":2}', {
        mode: 0o600,
      });
      await rename(`${layout.runtimeStatusPath}.tmp`, layout.runtimeStatusPath);
      await until(() => output.length === 2);
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
      await until(() => output.length === 1);
      installed = true;
      await mkdir(layout.stateRoot, { recursive: true, mode: 0o700 });
      await writeFile(layout.runtimeStatusPath, "{}", { mode: 0o600 });
      await until(() => output.length === 2);
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
      await until(() => output.length === 1);
      await rename(layout.stateRoot, `${layout.stateRoot}-previous`);
      await mkdir(layout.stateRoot, { mode: 0o700 });
      await writeFile(layout.runtimeStatusPath, '{"generation":2}', {
        mode: 0o600,
      });
      await until(() => output.length === 2);
      await writeFile(layout.runtimeStatusPath, '{"generation":3}', {
        mode: 0o600,
      });
      await until(() => output.length === 3);
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
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("snapshot did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
