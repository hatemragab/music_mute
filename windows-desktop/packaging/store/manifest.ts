import {
  STORE_PRODUCTS,
  parseStoreBuildNumber,
  parseStorePackageVersion,
  type StoreProductRole,
} from "../../src/shared/store-contracts.js";
import { win32 } from "node:path";

export const STORE_NAMESPACE_PROFILE = "packaged-classic-v1";
export const STORE_REQUESTED_CAPABILITIES = Object.freeze([
  "runFullTrust",
] as const);
export type StoreNamespaceProfile =
  "packaged-classic-v1" | "unvirtualized-candidate-v1";
export const STORE_STARTUP_TASK_ID = "MusicMuteWorkerStartup";
export const STORE_CHROME_HOST_APPLICATION_ID = "MusicMuteChromeHost";
export const STORE_WORKER_SESSION_APPLICATION_ID = "MusicMuteWorkerSession";
export const STORE_ASSET_DIMENSIONS = Object.freeze({
  "StoreLogo.png": [50, 50],
  "Square44x44Logo.png": [44, 44],
  "Square150x150Logo.png": [150, 150],
  "Wide310x150Logo.png": [310, 150],
} as const);
export interface StoreManifestOptions {
  packageVersion: string;
  appBuildNumber: number;
  namespaceProfile: StoreNamespaceProfile;
}

function invalid(): never {
  throw new Error("STORE_MANIFEST_INVALID");
}
function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
/** Main packages only; capability declarations are requests, never approvals. */
export function renderStoreManifest(
  role: StoreProductRole,
  options: StoreManifestOptions,
): string {
  if (
    (role !== "gui" && role !== "worker") ||
    !options ||
    (Object.getPrototypeOf(options) !== Object.prototype &&
      Object.getPrototypeOf(options) !== null) ||
    Reflect.ownKeys(options).some((key) => typeof key !== "string") ||
    Reflect.ownKeys(options).sort().join() !==
      "appBuildNumber,namespaceProfile,packageVersion" ||
    Object.values(Object.getOwnPropertyDescriptors(options)).some(
      (descriptor) => !descriptor.enumerable || !("value" in descriptor),
    )
  )
    invalid();
  options = Object.freeze({ ...options });
  if (
    !["packaged-classic-v1", "unvirtualized-candidate-v1"].includes(
      options.namespaceProfile,
    )
  )
    invalid();
  const product = STORE_PRODUCTS[role];
  const version = parseStorePackageVersion(options.packageVersion, true);
  parseStoreBuildNumber(options.appBuildNumber);
  if (version.semanticVersion !== product.appVersion) invalid();
  const executable =
    role === "gui"
      ? "app\\MusicMuteSession.exe"
      : "worker\\MusicMuteWorker.exe";
  const unvirtualized =
    options.namespaceProfile === "unvirtualized-candidate-v1";
  // The minimum OS supports uap10 activation. FullTrustApplication aliases
  // packagedClassicApp and conflicts with win32App, including on extensions.
  const runtimeBehavior = unvirtualized ? "win32App" : "packagedClassicApp";
  const extensions =
    role === "gui"
      ? `
        <uap:Extension Category="windows.protocol">
          <uap:Protocol Name="musicmute-local"><uap:DisplayName>MusicMute</uap:DisplayName></uap:Protocol>
        </uap:Extension>`
      : "";
  // The SDK requires an explicitly multi-instance Application for a console
  // alias. A separate hidden entry preserves the primary GUI launcher's behavior.
  const chromeHost =
    role === "gui"
      ? `
    <Application Id="${STORE_CHROME_HOST_APPLICATION_ID}" Executable="app\\MusicMuteChromeHost.exe" uap10:RuntimeBehavior="${runtimeBehavior}" uap10:TrustLevel="mediumIL" desktop4:Subsystem="console" desktop4:SupportsMultipleInstances="true">
      <uap:VisualElements AppListEntry="none" DisplayName="MusicMute Chrome host" Description="MusicMute Chrome native messaging" BackgroundColor="#15151B" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" />
      <Extensions>
        <uap5:Extension Category="windows.appExecutionAlias" Executable="app\\MusicMuteChromeHost.exe" uap10:RuntimeBehavior="${runtimeBehavior}" uap10:TrustLevel="mediumIL">
          <uap5:AppExecutionAlias desktop4:Subsystem="console"><uap5:ExecutionAlias Alias="MusicMuteChromeHost.exe" /></uap5:AppExecutionAlias>
        </uap5:Extension>
      </Extensions>
    </Application>`
      : "";
  // OS activation owns the session's lifetime. Its entry is independent of the
  // GUI/control application's transient Job and is also the login task target.
  const workerSession =
    role === "worker"
      ? `
    <Application Id="${STORE_WORKER_SESSION_APPLICATION_ID}" Executable="worker\\MusicMuteSession.exe" uap10:RuntimeBehavior="${runtimeBehavior}" uap10:TrustLevel="mediumIL">
      <uap:VisualElements AppListEntry="none" DisplayName="MusicMute Worker session" Description="MusicMute logged-in user processing session" BackgroundColor="#15151B" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" />
      <Extensions>
        <desktop:Extension Category="windows.startupTask" Executable="worker\\MusicMuteSession.exe" uap10:RuntimeBehavior="${runtimeBehavior}" uap10:TrustLevel="mediumIL">
          <desktop:StartupTask TaskId="${STORE_STARTUP_TASK_ID}" Enabled="false" DisplayName="MusicMute Worker" />
        </desktop:Extension>
      </Extensions>
    </Application>`
      : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap5="http://schemas.microsoft.com/appx/manifest/uap/windows10/5"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  xmlns:desktop4="http://schemas.microsoft.com/appx/manifest/desktop/windows10/4"
  xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap5 uap10 desktop desktop4 desktop6 rescap">
  <Identity Name="${product.identityName}" Publisher="${product.publisher}" ProcessorArchitecture="x64" Version="${version.text}" />
  <Properties>
    <DisplayName>${xml(product.displayName)}</DisplayName><PublisherDisplayName>VCHATSDK</PublisherDisplayName>
    <Description>${role === "gui" ? "MusicMute audio processing and Library" : "MusicMute logged-in user GPU worker"}</Description><Logo>Assets\\StoreLogo.png</Logo>
    ${unvirtualized ? "<desktop6:RegistryWriteVirtualization>disabled</desktop6:RegistryWriteVirtualization><desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>" : ""}
  </Properties>
  <Resources><Resource Language="en-US" /><Resource Language="ar" /></Resources>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19045.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
  <Applications>
    <Application Id="${product.applicationId}" Executable="${executable}" uap10:RuntimeBehavior="${runtimeBehavior}" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="${xml(product.displayName)}" Description="${role === "gui" ? "MusicMute audio processing and Library" : "MusicMute logged-in user GPU worker"}" BackgroundColor="#15151B" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\\Wide310x150Logo.png" />
      </uap:VisualElements>
      <Extensions>${extensions}
      </Extensions>
    </Application>${chromeHost}${workerSession}
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" />${unvirtualized ? '<rescap:Capability Name="unvirtualizedResources" />' : ""}</Capabilities>
</Package>
`;
}

/** Exact pinned builder config for a GUI directory, never NSIS or publication. */
export function storeElectronDirectoryConfig(stage: string) {
  if (
    !/^[A-Za-z]:\\/u.test(stage) ||
    /[\p{Cc}\p{Cf};"$<>|?*]/u.test(stage) ||
    stage.includes("/") ||
    win32.resolve(stage) !== stage ||
    win32.parse(stage).root === stage
  )
    invalid();
  const join = (tail: string) => `${stage}\\${tail}`;
  return {
    appId: "com.musicmute.local.windows",
    productName: "MusicMute Local",
    electronVersion: "44.7.0",
    asar: true,
    disableAsarIntegrity: false,
    forceCodeSigning: false, // Upload-only directory; legacy NSIS config is separate.
    npmRebuild: false,
    nodeGypRebuild: false,
    publish: null,
    directories: {
      app: join("application"),
      buildResources: join("assets"),
      output: join("electron-output"),
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
    extraResources: [{ from: join("resources"), to: ".", filter: ["**/*"] }],
    extraFiles: ["MusicMuteSession.exe", "MusicMuteChromeHost.exe"].map(
      (name) => ({ from: join(`root\\${name}`), to: name }),
    ),
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
      target: [{ target: "dir", arch: ["x64"] }],
      executableName: "MusicMute Local",
      icon: join("assets\\app-icon.ico"),
      requestedExecutionLevel: "asInvoker",
      signAndEditExecutable: true,
      signExecutable: false,
    },
  };
}
