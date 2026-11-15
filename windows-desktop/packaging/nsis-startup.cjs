const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { assertPinnedBuilderFunction } = require("./builder-compat.cjs");
const GUARDED_UNINSTALLER = "musicmute-owned-uninstaller.nsh";
const INIT =
  "Function .onInit\n  Call setInstallSectionSpaceRequired\n\n  SetOutPath $INSTDIR\n  ${LogSet} on\n\n  !ifmacrodef preInit\n    !insertmacro preInit\n  !endif";
function guardPinnedInstallerStartup(source) {
  const script = source.replaceAll("\r\n", "\n");
  if (
    script.split(INIT).length !== 2 ||
    script.split('!include "uninstaller.nsh"').length !== 2
  )
    throw new Error("PACKAGE_BUILDER_VERSION_MISMATCH");
  return script
    .replace(
      INIT,
      'Function .onInit\n  !ifdef BUILD_UNINSTALLER\n    WriteUninstaller "${UNINSTALLER_OUT_FILE}"\n    !insertmacro quitSuccess\n  !endif\n\n  !ifmacrodef preInit\n    !insertmacro preInit\n  !endif\n\n  Call setInstallSectionSpaceRequired\n  SetOutPath $INSTDIR\n  ${LogSet} on',
    )
    .replace('!include "uninstaller.nsh"', `!include "${GUARDED_UNINSTALLER}"`);
}
function guardPinnedUninstallerStartup(source) {
  const script = source.replaceAll("\r\n", "\n"),
    start = "Function un.onInit\n  SetOutPath $INSTDIR";
  if (script.split(start).length !== 2)
    throw new Error("PACKAGE_BUILDER_VERSION_MISMATCH");
  return script.replace(
    start,
    "Function un.onInit\n  !insertmacro MusicMutePathPreflight\n  SetOutPath $INSTDIR",
  );
}
/** Keep v26's normal signed-uninstaller generation. A custom nsis.script would
 * skip that signer. Change only the exact reviewed startup ordering in memory. */
async function installPinnedNsisStartupGuard(stage) {
  // Initialize the public module first. Requiring NsisTarget before its public
  // package graph is initialized creates a v26 circular PlatformPackager load.
  require("electron-builder");
  if (require("app-builder-lib/package.json").version !== "26.15.3")
    throw new Error("PACKAGE_BUILDER_VERSION_MISMATCH");
  const templates = path.join(
    path.dirname(require.resolve("app-builder-lib/package.json")),
    "templates",
    "nsis",
  );
  const stock = await readFile(path.join(templates, "installer.nsi"), "utf8");
  guardPinnedInstallerStartup(stock);
  await writeFile(
    path.join(stage, "installer", GUARDED_UNINSTALLER),
    guardPinnedUninstallerStartup(
      await readFile(path.join(templates, "uninstaller.nsh"), "utf8"),
    ),
    { flag: "wx" },
  );
  const {
      NsisTarget,
    } = require("app-builder-lib/out/targets/nsis/NsisTarget.js"),
    original = NsisTarget.prototype.computeFinalScript;
  assertPinnedBuilderFunction("computeFinalScript", original);
  NsisTarget.prototype.computeFinalScript = function (
    script,
    isInstaller,
    archs,
  ) {
    if (script.replaceAll("\r\n", "\n") !== stock.replaceAll("\r\n", "\n"))
      throw new Error("PACKAGE_BUILDER_VERSION_MISMATCH");
    return original.call(
      this,
      guardPinnedInstallerStartup(script),
      isInstaller,
      archs,
    );
  };
  return () => {
    NsisTarget.prototype.computeFinalScript = original;
  };
}
module.exports = {
  guardPinnedInstallerStartup,
  guardPinnedUninstallerStartup,
  installPinnedNsisStartupGuard,
};
