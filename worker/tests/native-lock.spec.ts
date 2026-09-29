import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { expect, it } from "vitest";
import {
  NativeLockBusyError,
  windowsLockPipeName,
  withNativeLock,
} from "../src/runtime/native-lock.js";

it("binds Windows locks to a normalized local path without exposing it", () => {
  expect(windowsLockPipeName("C:\\MusicMute\\state\\lock")).toBe(
    windowsLockPipeName("c:\\musicmute\\state\\lock"),
  );
  expect(windowsLockPipeName("C:\\MusicMute\\state\\lock")).not.toBe(
    windowsLockPipeName("C:\\MusicMute\\state\\other"),
  );
  expect(windowsLockPipeName("C:\\MusicMute\\state\\lock")).not.toContain(
    "MusicMute\\state",
  );
  expect(() => windowsLockPipeName("\\\\server\\share\\lock")).toThrow();
  expect(() => windowsLockPipeName("relative")).toThrow();
});

it.skipIf(!["darwin", "win32"].includes(process.platform))(
  "excludes concurrent owners and releases after an operation throws",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "mw-native-lock-"));
    const path = join(root, "guard");
    try {
      await expect(
        withNativeLock(path, async () => {
          await expect(
            withNativeLock(path, async () => true),
          ).rejects.toBeInstanceOf(NativeLockBusyError);
          throw new Error("fixture failure");
        }),
      ).rejects.toThrow("fixture failure");
      await expect(withNativeLock(path, async () => "recovered")).resolves.toBe(
        "recovered",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "excludes the PowerShell installer and Node CLI in both directions and recovers after death",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "mw-installer-lock-"));
    await mkdir(join(root, "state"));
    const path = join(root, "state", "operator.lock");
    const manager = resolve(
      import.meta.dirname,
      "../scripts/windows-service-functions.ps1",
    );
    const script = `$ErrorActionPreference='Stop';
$Ast=[Management.Automation.Language.Parser]::ParseFile('${manager.replaceAll("'", "''")}',[ref]$null,[ref]$null)
$Function=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'New-OperatorLock'},$true)
. ([ScriptBlock]::Create($Function.Extent.Text))
$Handle=New-OperatorLock '${root.replaceAll("'", "''")}'
try { [Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null } finally { $Handle.Dispose() }`;
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ];
    const powershell = join(
      process.env.SystemRoot!,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    try {
      await withNativeLock(path, async () => {
        await expect(
          promisify(execFile)(powershell, args, { timeout: 20_000 }),
        ).rejects.toThrow("Another MusicMute operation owns this lock");
      });
      const child = spawn(powershell, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      try {
        await Promise.race([
          once(child.stdout!, "data").then(([data]) =>
            expect(String(data)).toContain("ready"),
          ),
          once(child, "exit").then(() => {
            throw new Error("Installer lock owner exited early");
          }),
        ]);
        await expect(withNativeLock(path, async () => true)).rejects.toThrow();
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        await expect(withNativeLock(path, async () => true)).resolves.toBe(
          true,
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  45_000,
);

it.skipIf(process.platform !== "win32")(
  "releases a Windows kernel lock when its process is killed",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "mw-dead-lock-"));
    const path = join(root, "guard");
    const pipe = windowsLockPipeName(path);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import net from "node:net"; net.createServer(s=>s.destroy()).listen(process.argv[1],()=>console.log("ready"));',
        pipe,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await Promise.race([
        once(child.stdout!, "data"),
        once(child, "exit").then(() => {
          throw new Error("Lock owner exited early");
        }),
      ]);
      await expect(
        withNativeLock(path, async () => true),
      ).rejects.toBeInstanceOf(NativeLockBusyError);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await expect(withNativeLock(path, async () => true)).resolves.toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await rm(root, { recursive: true, force: true });
    }
  },
);
