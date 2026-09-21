import { describe, expect, it, vi } from "vitest";
import { readHiddenTerminalLine } from "../src/platform/macos/secret-prompt.js";

describe("macOS hidden enrollment prompt", () => {
  it("refuses non-interactive installation before opening the terminal", async () => {
    const openTty = vi.fn();
    await expect(
      readHiddenTerminalLine("Enrollment: ", {
        interactive: false,
        openTty,
      }),
    ).rejects.toThrow("interactive terminal");
    expect(openTty).not.toHaveBeenCalled();
  });

  it("reads bounded ASCII without echo and always restores terminal echo", async () => {
    const fixture = terminal("secret-code\n");
    await expect(
      readHiddenTerminalLine("Enrollment: ", {
        interactive: true,
        openTty: async () => fixture.tty,
        setEcho: fixture.setEcho,
      }),
    ).resolves.toBe("secret-code");
    expect(fixture.setEcho.mock.calls).toEqual([[false], [true]]);
    expect(fixture.writes).toEqual(["Enrollment: ", "\n"]);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["cancellation", `${String.fromCharCode(3)}`, "cancelled"],
    ["unsupported input", `${String.fromCharCode(1)}`, "unsupported"],
    ["oversized input", `${"x".repeat(257)}\n`, "too long"],
  ])("restores echo after %s", async (_name, input, message) => {
    const fixture = terminal(input);
    await expect(
      readHiddenTerminalLine("Enrollment: ", {
        interactive: true,
        openTty: async () => fixture.tty,
        setEcho: fixture.setEcho,
      }),
    ).rejects.toThrow(message);
    expect(fixture.setEcho.mock.calls).toEqual([[false], [true]]);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("rejects control characters in the displayed prompt", async () => {
    await expect(
      readHiddenTerminalLine("Enrollment:\n", { interactive: true }),
    ).rejects.toThrow("prompt is invalid");
  });
});

function terminal(input: string) {
  const bytes = Buffer.from(input, "utf8");
  let offset = 0;
  const writes: string[] = [];
  const close = vi.fn(async () => undefined);
  const setEcho = vi.fn(async (_enabled: boolean) => undefined);
  const tty = {
    write: async (value: string) => {
      writes.push(value);
    },
    read: async (buffer: Buffer) => {
      if (offset >= bytes.length) return { bytesRead: 0 };
      buffer[0] = bytes[offset]!;
      offset += 1;
      return { bytesRead: 1 };
    },
    close,
  };
  return { tty, writes, close, setEcho };
}
