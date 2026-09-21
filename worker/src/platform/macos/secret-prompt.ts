import { execFile as nodeExecFile } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

interface TerminalHandle {
  write(value: string): Promise<unknown>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface HiddenTerminalDependencies {
  interactive?: boolean;
  openTty?: () => Promise<TerminalHandle>;
  setEcho?: (enabled: boolean) => Promise<void>;
}

export async function readHiddenTerminalLine(
  prompt: string,
  dependencies: HiddenTerminalDependencies = {},
): Promise<string> {
  if (prompt.length < 1 || prompt.length > 160 || /[\r\n\0]/u.test(prompt))
    throw new TypeError("Secret prompt is invalid");
  const interactive =
    dependencies.interactive ??
    (process.stdin.isTTY === true && process.stderr.isTTY === true);
  if (!interactive)
    throw new TypeError("Installation requires an interactive terminal");
  const tty = await (
    dependencies.openTty ?? (async () => await open("/dev/tty", "r+"))
  )();
  const setEcho =
    dependencies.setEcho ??
    (async (enabled: boolean) =>
      await execFile("/bin/stty", [
        "-f",
        "/dev/tty",
        enabled ? "echo" : "-echo",
      ]).then(() => undefined));
  let echoDisabled = false;
  try {
    await tty.write(prompt);
    await setEcho(false);
    echoDisabled = true;
    let value = "";
    const buffer = Buffer.alloc(1);
    while (value.length <= 256) {
      const { bytesRead } = await tty.read(buffer, 0, 1, null);
      if (bytesRead === 0 || buffer[0] === 10 || buffer[0] === 13) break;
      if (buffer[0] === 3 || buffer[0] === 4)
        throw new Error("Secret input was cancelled");
      if (buffer[0]! < 0x20 || buffer[0]! > 0x7e)
        throw new TypeError("Secret input contains unsupported characters");
      value += buffer.toString("utf8", 0, bytesRead);
    }
    if (value.length > 256) throw new TypeError("Secret input is too long");
    return value.trim();
  } finally {
    if (echoDisabled) await setEcho(true).catch(() => undefined);
    await tty.write("\n").catch(() => undefined);
    await tty.close();
  }
}
