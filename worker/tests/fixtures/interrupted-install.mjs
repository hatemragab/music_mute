import { registerHooks } from "node:module";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
const sourceRoot = process.argv[2];
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      context.parentURL?.startsWith(sourceRoot) && specifier.endsWith(".js")
        ? specifier.slice(0, -3) + ".ts"
        : specifier,
      context,
    );
  },
});
const input = JSON.parse(await readFile(process.argv[3], "utf8"));
const mode = process.argv[4];
const { installMacUserWorker } = await import(
  new URL("platform/macos/user-installer.ts", sourceRoot)
);
const { runMacUserCommand } = await import(
  new URL("platform/macos/user-cli.ts", sourceRoot)
);
const { withMacUserCommandLock } = await import(
  new URL("platform/macos/command-lock.ts", sourceRoot)
);
async function boundary(name) {
  if (mode !== "install" || input.boundary !== name) return;
  process.send({ boundary: name });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const launchAgent = {
  status: async () => {
    const loaded = JSON.parse(await readFile(input.servicePath, "utf8"));
    if (loaded) await boundary("service-loaded");
    return { loaded, running: false };
  },
  bootout: async () => writeFile(input.servicePath, "false"),
  bootstrap: async () => {
    await boundary("bootstrap");
    await appendFile(input.serviceCallsPath, "bootstrap\n");
    await writeFile(input.servicePath, "true");
  },
};
if (mode === "install") {
  await withMacUserCommandLock(
    input.layout.commandLockPath,
    async () => {
      await installMacUserWorker({
        layout: input.layout,
        uid: process.getuid(),
        label: "Interrupted fixture",
        enrollmentCredential: "x".repeat(43),
        launchAgent,
        inspectRuntime: async () => input.runtime,
        prepare: async (args) => {
          await appendFile(input.callsPath, "prepare\n");
          const output = args[args.indexOf("--output") + 1];
          await writeFile(
            join(output, "installation-artifacts.json"),
            JSON.stringify(input.artifacts),
            { mode: 0o600 },
          );
        },
        enroll: async (args) => {
          await appendFile(input.callsPath, "enroll\n");
          const output = args[args.indexOf("--output") + 1];
          await writeFile(
            join(output, ".enrollment-state.json"),
            JSON.stringify(input.identity),
            { mode: 0o600 },
          );
          await writeFile(
            join(output, "machine.credential"),
            "m".repeat(43) + "\n",
            { mode: 0o600 },
          );
        },
        qualify: async () => join(input.layout.stateRoot, "qualification.json"),
      });
    },
    "install",
  );
} else {
  const result = await runMacUserCommand("install", [], {
    layout: input.layout,
    host: {
      platform: "darwin",
      arch: "arm64",
      uid: process.getuid(),
      home: input.layout.homeRoot,
    },
    launchAgent,
    stdout: () => {},
    readEnrollmentCode: async () => {
      throw new Error("Recovery must not request another enrollment code");
    },
  });
  if (result !== 0) throw new Error("Installation recovery failed");
}
process.disconnect();
