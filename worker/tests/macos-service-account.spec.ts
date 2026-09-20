import { describe, expect, it } from "vitest";
import {
  ensureMacServiceAccount,
  type MacAccountCommand,
} from "../src/platform/macos/service-account.js";

type RecordState = { id: number; primaryGroup?: string };

function fakeDirectory(initial?: {
  user?: RecordState;
  group?: RecordState;
  used?: readonly number[];
}) {
  let user = initial?.user;
  let group = initial?.group;
  const calls: string[][] = [];
  const run: MacAccountCommand = async (executable, arguments_) => {
    const args = [...arguments_];
    calls.push([executable, ...args]);
    if (executable === "/usr/bin/id") {
      if (!user) return { code: 1, stdout: "" };
      if (args[0] === "-u") return { code: 0, stdout: `${user.id}\n` };
      if (args[0] === "-g")
        return { code: 0, stdout: `${group?.id ?? user.id}\n` };
      return { code: 0, stdout: `${user.primaryGroup ?? "_musicmute"}\n` };
    }
    const action = args[1];
    const path = args[2] ?? "";
    const isUser = path === "/Users/_musicmute";
    const isGroup = path === "/Groups/_musicmute";
    if (action === "-read") {
      const record = isUser ? user : isGroup ? group : undefined;
      if (!record) return { code: 1, stdout: "" };
      const property = args[3];
      return {
        code: 0,
        stdout:
          property === undefined ? "record\n" : `${property}: ${record.id}\n`,
      };
    }
    if (action === "-list")
      return {
        code: 0,
        stdout: (initial?.used ?? [])
          .map((id) => `existing${id} ${id}`)
          .join("\n"),
      };
    if (action === "-create") {
      if (isGroup) group ??= { id: -1 };
      if (isUser) user ??= { id: -1, primaryGroup: "_musicmute" };
      if (args[3] === "PrimaryGroupID" && isGroup) group!.id = Number(args[4]);
      if (args[3] === "UniqueID" && isUser) user!.id = Number(args[4]);
      return { code: 0, stdout: "" };
    }
    if (action === "-delete") {
      if (isUser) user = undefined;
      if (isGroup) group = undefined;
      return { code: 0, stdout: "" };
    }
    return { code: 1, stdout: "" };
  };
  return { run, calls, state: () => ({ user, group }) };
}

describe("macOS service account provisioning", () => {
  it("reuses a valid existing dedicated account", async () => {
    const directory = fakeDirectory({
      user: { id: 495, primaryGroup: "_musicmute" },
      group: { id: 495 },
    });
    await expect(
      ensureMacServiceAccount("_musicmute", "_musicmute", directory.run),
    ).resolves.toEqual({ owner: { uid: 495, gid: 495 }, created: false });
    expect(directory.calls.some((call) => call.includes("-create"))).toBe(
      false,
    );
  });

  it("creates a hidden non-login account using an unused system ID", async () => {
    const directory = fakeDirectory({ used: [499, 498] });
    await expect(
      ensureMacServiceAccount("_musicmute", "_musicmute", directory.run),
    ).resolves.toEqual({ owner: { uid: 497, gid: 497 }, created: true });
    expect(directory.state()).toEqual({
      user: { id: 497, primaryGroup: "_musicmute" },
      group: { id: 497 },
    });
    expect(directory.calls).toContainEqual([
      "/usr/bin/dscl",
      ".",
      "-create",
      "/Users/_musicmute",
      "UserShell",
      "/usr/bin/false",
    ]);
    expect(directory.calls).toContainEqual([
      "/usr/bin/dscl",
      ".",
      "-create",
      "/Users/_musicmute",
      "IsHidden",
      "1",
    ]);
  });

  it("rejects partial state and absent custom identities", async () => {
    await expect(
      ensureMacServiceAccount(
        "_musicmute",
        "_musicmute",
        fakeDirectory({ group: { id: 490 } }).run,
      ),
    ).rejects.toThrow("state is incomplete");
    await expect(
      ensureMacServiceAccount("custom", "custom", fakeDirectory().run),
    ).rejects.toThrow("restricted to _musicmute");
  });
});
