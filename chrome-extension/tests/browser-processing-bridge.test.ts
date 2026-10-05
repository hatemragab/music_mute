import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserProcessingBridge } from "../src/companion/browser-processing-bridge.js";

const owner = { uid: "browser-owner", session_generation: randomUUID() };
const session = {
  firebase_uid: owner.uid,
  session_generation: owner.session_generation,
  installation_id: randomUUID(),
  id_token: "synthetic.token.signature",
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(script: string) {
  const root = await mkdtemp(join(tmpdir(), "musicmute-browser-bridge-"));
  directories.push(root);
  const macos = join(root, "Contents", "MacOS");
  await mkdir(macos, { recursive: true });
  const helper = join(macos, "MusicMuteLocal");
  await writeFile(helper, `#!${process.execPath}\n${script}\n`, {
    mode: 0o700,
  });
  await chmod(helper, 0o700);
  return new BrowserProcessingBridge({
    root,
    app_resources: join(root, "Contents", "Resources"),
  });
}
describe("native browser processing preference and session", () => {
  it("reads the saved app choice for every new request", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ processing_mode: "cloud" })
      .mockResolvedValueOnce({ processing_mode: "local" });
    const bridge = new BrowserProcessingBridge({ root: "/unused" }, execute);
    expect(await bridge.provider()).toBe("ONLINE_MUSICMUTE");
    expect(await bridge.provider()).toBe("LOCAL_MACOS");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith({ operation: "settings" }, undefined);
  });
  it.each([
    null,
    [],
    { processing_mode: "other" },
    { processing_mode: "cloud", token: "private" },
  ])(
    "rejects malformed native preferences without selecting a provider",
    async (value) => {
      const bridge = new BrowserProcessingBridge(
        { root: "/unused" },
        async () => value,
      );
      await expect(bridge.provider()).rejects.toThrow(
        /^PROCESSING_(?:BRIDGE|SELECTION)_UNAVAILABLE$/,
      );
    },
  );
  it("returns only a validated session bound to the captured owner", async () => {
    const execute = vi.fn().mockResolvedValue(session);
    const bridge = new BrowserProcessingBridge({ root: "/unused" }, execute);
    expect(await bridge.session(owner)).toEqual(session);
    expect(execute).toHaveBeenCalledWith(
      {
        operation: "session",
        firebase_uid: owner.uid,
        session_generation: owner.session_generation,
      },
      undefined,
    );
    execute.mockResolvedValue({ ...session, session_generation: randomUUID() });
    await expect(bridge.session(owner)).rejects.toThrow("ACCOUNT_CHANGED");
    execute.mockResolvedValue({ ...session, refresh_token: "private" });
    await expect(bridge.session(owner)).rejects.toThrow(
      "ACCOUNT_SESSION_UNAVAILABLE",
    );
  });
  it("passes secrets only through native pipes and bounds/redacts helper errors", async () => {
    const bridge = await fixture(`
      let raw = ''; for await (const chunk of process.stdin) raw += chunk;
      if (process.argv.length !== 3 || process.argv[2] !== '--browser-processing-bridge' || !process.env.MUSICMUTE_LOCAL_ROOT) process.exit(1);
      const value = JSON.parse(raw);
      process.stdout.write(JSON.stringify(value.operation === 'settings' ? {processing_mode:'cloud'} : ${JSON.stringify(session)}));
    `);
    expect(await bridge.provider()).toBe("ONLINE_MUSICMUTE");
    expect(await bridge.session(owner)).toEqual(session);
    const failed = await fixture(
      "process.stderr.write('private-token'); process.exit(1);",
    );
    await expect(failed.provider()).rejects.toThrow(
      /^PROCESSING_BRIDGE_UNAVAILABLE$/,
    );
    const oversized = await fixture("process.stdout.write('x'.repeat(16385));");
    await expect(oversized.provider()).rejects.toThrow(
      /^PROCESSING_BRIDGE_UNAVAILABLE$/,
    );
    const privateError = new BrowserProcessingBridge(
      { root: "/unused" },
      async () => ({ error_code: "raw private token" }),
    );
    await expect(privateError.provider()).rejects.toThrow(
      /^PROCESSING_BRIDGE_UNAVAILABLE$/,
    );
  });
  it("stops a pending native credential read when cancelled", async () => {
    const bridge = await fixture("setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const pending = bridge.session(owner, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/^CANCELLED$/);
  });
});
