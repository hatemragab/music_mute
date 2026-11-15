const path = require("node:path");
const fs = require("node:fs");

function createConfig(stage) {
  if (!path.isAbsolute(stage)) throw new Error("PACKAGE_STAGE_REQUIRED");
  const seal = JSON.parse(
    fs.readFileSync(path.join(stage, "app", "packaged-resources.json"), "utf8"),
  );
  if (
    seal.version !== 1 ||
    seal.appId !== "com.musicmute.local.windows" ||
    !/^[a-f0-9]{64}$/.test(seal.publisherSha256)
  )
    throw new Error("PACKAGE_STAGE_INVALID");
  return {
    appId: "com.musicmute.local.windows",
    productName: "MusicMute Local",
    electronVersion: "44.7.0",
    asar: true,
    disableAsarIntegrity: false,
    npmRebuild: false,
    nodeGypRebuild: false,
    forceCodeSigning: true,
    publish: null,
    directories: {
      app: path.join(stage, "app"),
      buildResources: path.join(stage, "installer"),
      output: path.join(stage, "output"),
    },
    files: [
      "package.json",
      "packaged-resources.json",
      "dist/main/main.cjs",
      "dist/preload/index.cjs",
      "dist/renderer/**/*",
      "dist/licenses/**/*",
      "!**/*.map",
    ],
    extraResources: [
      { from: path.join(stage, "resources"), to: ".", filter: ["**/*"] },
    ],
    extraFiles: ["MusicMuteSession.exe", "MusicMuteChromeHost.exe"].map(
      (name) => ({ from: path.join(stage, "root", name), to: name }),
    ),
    protocols: [], // Owned URI registration is performed by the guarded installer lifecycle.
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false,
      grantFileProtocolExtraPrivileges: false,
    },
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      executableName: "MusicMute Local",
      icon: path.join(stage, "installer", "app-icon.ico"),
      requestedExecutionLevel: "asInvoker",
      signAndEditExecutable: true,
      // Keep final signed/hash-bound helper bytes intact through v26 copying.
      signExts: [
        "!musicmute-native.exe",
        "!MusicMuteSession.exe",
        "!MusicMuteChromeHost.exe",
      ],
      signtoolOptions: {
        signingHashAlgorithms: ["sha256"],
        sign: path.join(__dirname, "sign-hook.cjs"),
      },
      verifyUpdateCodeSignature: true,
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      packElevateHelper: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      deleteAppDataOnUninstall: false,
      runAfterFinish: false,
      buildUniversalInstaller: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: "MusicMute Local",
      uninstallDisplayName: "MusicMute Local",
      include: path.join(stage, "installer", "installer.nsh"),
      artifactName: "MusicMute-Local-${version}-x64.${ext}",
    },
    afterSign: path.join(__dirname, "after-sign.cjs"),
    artifactBuildCompleted: path.join(__dirname, "artifact-audit.cjs"),
  };
}
module.exports = { createConfig };
if (process.env.MUSICMUTE_PACKAGE_STAGE)
  module.exports = createConfig(
    path.resolve(process.env.MUSICMUTE_PACKAGE_STAGE),
  );
