import { spawn } from "node:child_process";

const SYSTEM_PREFIXES = ["/usr/lib/", "/System/Library/"] as const;
const RELATIVE_PREFIXES = [
  "@rpath/",
  "@loader_path/",
  "@executable_path/",
] as const;

export async function auditMacRuntimeBinary(path: string): Promise<void> {
  const architectures = (await tool("/usr/bin/lipo", ["-archs", path]))
    .trim()
    .split(/\s+/u);
  if (!architectures.some((architecture) => architecture.startsWith("arm64")))
    throw new TypeError("Mac runtime binary does not contain ARM64 code");
  const dependencies = await tool("/usr/bin/otool", ["-L", path]);
  for (const line of dependencies.split(/\r?\n/u).slice(1)) {
    const dependency = line.trim().split(/\s+/u)[0];
    if (dependency && !allowedPath(dependency))
      throw new TypeError("Mac runtime binary has a non-private dependency");
  }
  const loadCommands = await tool("/usr/bin/otool", ["-l", path]);
  const lines = loadCommands.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "cmd LC_RPATH") continue;
    const pathLine = lines
      .slice(index + 1, index + 6)
      .find((line) => line.trim().startsWith("path "));
    const rpath = pathLine?.trim().split(/\s+/u)[1];
    if (!rpath || !allowedPath(rpath))
      throw new TypeError("Mac runtime binary has a non-private rpath");
  }
}

function allowedPath(value: string): boolean {
  return (
    SYSTEM_PREFIXES.some((prefix) => value.startsWith(prefix)) ||
    RELATIVE_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

async function tool(command: string, arguments_: string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 2 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null || code !== 0 || stdout.length > 2 * 1024 * 1024)
        return reject(new TypeError("Mac runtime binary audit failed"));
      resolvePromise(stdout);
    });
  });
}
