const path = require("node:path");
const { installPinnedNsisStartupGuard } = require("./nsis-startup.cjs");
async function build() {
  const stage = process.argv[2];
  if (
    process.argv.length !== 3 ||
    !stage ||
    !path.isAbsolute(stage) ||
    process.env.MUSICMUTE_PACKAGE_STAGE !== stage
  )
    throw new Error("PACKAGE_STAGE_REQUIRED");
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("WINDOWS_PACKAGE_MACHINE_REQUIRED");
  const supplied = require("./config.cjs"),
    config =
      typeof supplied.createConfig === "function"
        ? supplied.createConfig(stage)
        : supplied;
  if (
    config.nsis.script ||
    config.nsis.oneClick !== true ||
    config.nsis.perMachine !== false ||
    config.forceCodeSigning !== true ||
    config.directories.app !== path.join(stage, "app")
  )
    throw new Error("PACKAGE_STAGE_INVALID");
  const { build: builderBuild, Platform, Arch } = require("electron-builder");
  const restore = await installPinnedNsisStartupGuard(stage);
  try {
    await builderBuild({
      targets: Platform.WINDOWS.createTarget("nsis", Arch.x64),
      publish: "never",
      config,
    });
  } finally {
    restore();
  }
}
build().catch((error) => {
  process.stderr.write(
    `${error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "PACKAGE_BUILD_FAILED"}\n`,
  );
  process.exitCode = 2;
});
