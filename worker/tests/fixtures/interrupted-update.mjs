import { registerHooks } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Run current source in a separate OS process, without depending on stale dist.
const sourceRoot = process.argv[2];
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.startsWith(sourceRoot) &&
      specifier.endsWith(".js")
    ) {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const input = JSON.parse(await readFile(process.argv[3], "utf8"));
const mode = process.argv[4];
const { updateMacUserWorker, recoverInterruptedMacUpdate } = await import(
  new URL("platform/macos/user-updater.ts", sourceRoot)
);
const { withMacUserCommandLock } = await import(
  new URL("platform/macos/command-lock.ts", sourceRoot)
);
let service = {
  status: async () => {
    const loaded = JSON.parse(await readFile(input.servicePath, "utf8"));
    return { loaded, running: loaded };
  },
  bootout: async () => writeFile(input.servicePath, "false"),
  bootstrap: async () => writeFile(input.servicePath, "true"),
};
if (input.nativeLabel) {
  if (!/^com\.musicmute\.recovery-test\.[a-f0-9-]{36}$/.test(input.nativeLabel))
    throw new Error("Unsafe native test label");
  const { MacLaunchAgentController, writeLaunchAgentPlist } = await import(
    new URL("platform/macos/launch-agent.ts", sourceRoot)
  );
  const execute = promisify(execFile);
  const controller = new MacLaunchAgentController(
    process.getuid(),
    async (file, args) => {
      const mapped = args.map((value) =>
        value === `gui/${process.getuid()}/com.musicmute.worker`
          ? `gui/${process.getuid()}/${input.nativeLabel}`
          : value,
      );
      if (mapped[0] === "bootstrap") {
        const plist = await readFile(mapped[2], "utf8");
        if (!plist.includes("<string>com.musicmute.worker</string>"))
          throw new Error("Unexpected test plist label");
        const isolated = `${mapped[2]}.native-test.plist`;
        await writeFile(
          isolated,
          plist.replace(
            "<string>com.musicmute.worker</string>",
            `<string>${input.nativeLabel}</string>`,
          ),
          { mode: 0o600 },
        );
        mapped[2] = isolated;
        await execute("/usr/bin/plutil", ["-lint", isolated], {
          timeout: 3000,
        });
      }
      return execute(file, mapped, { timeout: 8000, encoding: "utf8" });
    },
  );
  service = {
    status: () => controller.status(),
    bootout: async () => {
      await controller.bootout();
      await writeFile(
        input.servicePath,
        JSON.stringify((await controller.status()).loaded),
      );
    },
    bootstrap: async (path) => {
      await controller.bootstrap(path);
      for (let i = 0; i < 50; i++) {
        if ((await controller.status()).running) {
          await writeFile(input.servicePath, "true");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Native test service did not run");
    },
  };
  if (mode === "update") {
    await writeLaunchAgentPlist(input.layout);
    await service.bootstrap(input.layout.plistPath);
  }
}
async function boundary(name) {
  if (input.boundary !== name) return;
  process.send({ boundary: name });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
await withMacUserCommandLock(
  input.layout.commandLockPath,
  async () => {
    if (mode === "recover") {
      await recoverInterruptedMacUpdate(input.layout, service);
      return;
    }
    const bytes = await readFile(input.archivePath);
    await updateMacUserWorker({
      layout: input.layout,
      uid: process.getuid(),
      candidate: async () => input.candidate,
      now: new Date(input.now),
      launchAgent: service,
      fetch: async () =>
        new Response(bytes, {
          headers: {
            "content-type": "application/gzip",
            "content-length": String(bytes.length),
          },
        }),
      qualify: async () => boundary("stopped"),
      confirmStarted: async () => {
        await boundary("activated");
        return true;
      },
      health: async () => true,
    });
  },
  "update",
);
process.disconnect();
