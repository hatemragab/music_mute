import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NativeAccountState,
  readAccountState,
} from "../src/companion/account-state.js";
const roots: string[] = [];
const monitors: NativeAccountState[] = [];
afterEach(async () => {
  for (const monitor of monitors.splice(0)) monitor.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mm-account-state-"));
  roots.push(root);
  const owner = { uid: "firebase-account-a", session_generation: randomUUID() };
  const path = join(root, "account-state.json");
  const publish = async (scope: typeof owner | undefined) => {
    const temporary = join(root, `.account-state-${randomUUID()}.tmp`);
    await writeFile(
      temporary,
      JSON.stringify({
        version: 1,
        firebase_uid: scope?.uid ?? null,
        session_generation: scope?.session_generation ?? null,
      }),
      { mode: 0o600 },
    );
    await rename(temporary, path);
  };
  return { root, owner, path, publish };
}
describe("trusted native account scope", () => {
  it("retries normal atomic publication races without accepting an unsafe owner", async () => {
    const env = await fixture();
    await env.publish(env.owner);
    let previous = env.owner;
    for (let index = 0; index < 40; index++) {
      const next = { ...env.owner, session_generation: randomUUID() };
      const [, observed] = await Promise.all([
        env.publish(next),
        readAccountState(env.root),
      ]);
      expect([previous, next]).toContainEqual(observed);
      expect(await readAccountState(env.root)).toEqual(next);
      previous = next;
    }
  });
  it("reads identity-only state and permits explicit or initial guest state", async () => {
    const env = await fixture();
    expect(await readAccountState(env.root)).toBeUndefined();
    await env.publish(env.owner);
    expect(await readAccountState(env.root)).toEqual(env.owner);
    await env.publish(undefined);
    expect(await readAccountState(env.root)).toBeUndefined();
  });
  it.each([
    "symlink",
    "hardlink",
    "permissions",
    "oversize",
    "malformed",
    "credential",
    "partial-owner",
  ])("refuses %s state instead of falling back to guest", async (mode) => {
    const env = await fixture();
    await env.publish(env.owner);
    if (mode === "symlink") {
      await rename(env.path, `${env.path}.owned`);
      await symlink(`${env.path}.owned`, env.path);
    } else if (mode === "hardlink") await link(env.path, `${env.path}.linked`);
    else if (mode === "permissions") await chmod(env.path, 0o644);
    else if (mode === "oversize") await writeFile(env.path, "x".repeat(4097));
    else if (mode === "malformed") await writeFile(env.path, "{");
    else if (mode === "credential")
      await writeFile(
        env.path,
        JSON.stringify({
          version: 1,
          firebase_uid: env.owner.uid,
          session_generation: env.owner.session_generation,
          id_token: "must-never-load",
        }),
      );
    else
      await writeFile(
        env.path,
        JSON.stringify({
          version: 1,
          firebase_uid: null,
          session_generation: env.owner.session_generation,
        }),
      );
    await expect(readAccountState(env.root)).rejects.toThrow(
      /ACCOUNT_STATE_(UNSAFE|INVALID)/,
    );
  });
  it("refuses linked or public support directories", async () => {
    const env = await fixture();
    const linked = join(env.root, "linked");
    await symlink(env.root, linked);
    await expect(readAccountState(linked)).rejects.toThrow(
      "ACCOUNT_STATE_UNSAFE",
    );
    const publicRoot = join(env.root, "public");
    await mkdir(publicRoot, { mode: 0o755 });
    await expect(readAccountState(publicRoot)).rejects.toThrow(
      "ACCOUNT_STATE_UNSAFE",
    );
  });
  it("observes atomic account switches and generation changes and invalidates previously accepted work", async () => {
    const env = await fixture();
    await env.publish(env.owner);
    const observer = vi.fn();
    const monitor = new NativeAccountState(env.root);
    monitors.push(monitor);
    const accepted = await monitor.start(observer);
    expect(accepted).toEqual(env.owner);
    expect(monitor.matches(accepted)).toBe(true);
    await env.publish({ ...env.owner, session_generation: randomUUID() });
    await vi.waitFor(() => expect(monitor.matches(accepted)).toBe(false));
    expect(observer).toHaveBeenCalledWith("ACCOUNT_CHANGED");
    const renewed = monitor.current();
    await env.publish({
      uid: "firebase-account-b",
      session_generation: randomUUID(),
    });
    expect(await monitor.isCurrent(renewed)).toBe(false);
    await vi.waitFor(() =>
      expect(monitor.current()?.uid).toBe("firebase-account-b"),
    );
    await env.publish(undefined);
    await vi.waitFor(() => expect(monitor.matches(undefined)).toBe(true));
  });
  it("invalidates malformed state without a guest transition and can recover a later valid publication", async () => {
    const env = await fixture();
    await env.publish(env.owner);
    const observer = vi.fn();
    const monitor = new NativeAccountState(env.root);
    monitors.push(monitor);
    await monitor.start(observer);
    await writeFile(env.path, "{", { mode: 0o600 });
    await vi.waitFor(() => expect(monitor.matches(env.owner)).toBe(false));
    expect(monitor.matches(undefined)).toBe(false);
    expect(() => monitor.current()).toThrow("ACCOUNT_STATE_UNSAFE");
    expect(observer).toHaveBeenCalledWith("ACCOUNT_STATE_UNSAFE");
    await env.publish(env.owner);
    await vi.waitFor(() => expect(monitor.matches(env.owner)).toBe(true));
    expect(await readFile(env.path, "utf8")).not.toContain("id_token");
  });
  it("contains cancellation observer failures and disposes native watchers", async () => {
    const env = await fixture();
    await env.publish(env.owner);
    const monitor = new NativeAccountState(env.root);
    await monitor.start(() => {
      throw new Error("observer exception");
    });
    const returned = monitor.current();
    returned!.uid = "mutated-copy";
    expect(monitor.matches(env.owner)).toBe(true);
    await env.publish(undefined);
    await vi.waitFor(() => expect(monitor.matches(undefined)).toBe(true));
    monitor.close();
    expect(monitor.matches(undefined)).toBe(false);
    await expect(monitor.start()).rejects.toThrow("ACCOUNT_STATE_CLOSED");
  });
});
