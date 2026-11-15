import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, readFile } from "node:fs/promises";
import { createConsumerNativeTransport } from "../src/platform/windows/consumer-native-transport.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), readFile: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!,
  bytes = Buffer.from("verified isolated helper fixture"),
  digest = createHash("sha256").update(bytes).digest("hex"),
  image = "C:\\fixture\\musicmute-native.exe";
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  spawn.mockReset();
  vi.mocked(lstat).mockResolvedValue({
    isFile: () => true,
    isSymbolicLink: () => false,
    nlink: 1,
    size: bytes.length,
  } as Awaited<ReturnType<typeof lstat>>);
  vi.mocked(readFile).mockResolvedValue(bytes);
});
afterEach(() => Object.defineProperty(process, "platform", platform));

describe("verified consumer helper console detachment (injected process adapter)", () => {
  it("retains framed pipes and EOF lifetime with a detached console, without unref or a shell", async () => {
    const stdin = new PassThrough(),
      stdout = new PassThrough(),
      stderr = new PassThrough(),
      child = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr,
        kill: vi.fn(),
        unref: vi.fn(),
      });
    stdin.on("data", (frame: Buffer) => {
      const request = JSON.parse(frame.toString());
      stdout.write(
        JSON.stringify({
          version: 1,
          id: request.id,
          ok: true,
          result: { fixture: true },
        }) + "\n",
      );
    });
    stdin.once("finish", () => child.emit("close", 0));
    spawn.mockReturnValue(child);
    const transport = await createConsumerNativeTransport(image, digest);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      image,
      [],
      expect.objectContaining({
        detached: true,
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(child.unref).not.toHaveBeenCalled();
    expect(await transport.request("identity", {})).toEqual({ fixture: true });
    await transport.close();
    expect(stdin.writableEnded).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
  });
  it("cannot detach or launch an unverified helper generation", async () => {
    await expect(
      createConsumerNativeTransport(image, "0".repeat(64)),
    ).rejects.toThrow("HELPER_INTEGRITY_INVALID");
    expect(spawn).not.toHaveBeenCalled();
  });
});
