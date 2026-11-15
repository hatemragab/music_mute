import { createHash } from "node:crypto";

export const UNSIGNED_OID =
  "OID.2.25.311729368913984317654407730594956997722=1";
// Dedicated QA public SPKI only. Its discarded private counterpart is neither
// retained nor used for signing. This is unrelated to the production extension.
export const QA_CHROME_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkhUbSz/c8NGM+r8SxGKI+npPpN+9nnNujR+VcteAM+n4212nmExNKwQx3WkcXtRQKpAaJ4wq67Q4NVydSdmpTkbckKN6eiHj1JxKwMhqthppKQQvp6aQUyZGuTd4XataZpGqiQRee3DmybENJ2oyY9qhoKJTErpRUXPElsCnXANjhxG5C4bPv6C3Sg4qUolg0eCDGzy+hFkDW4hpErrAWUCWHflJk/jw/irTwkL3ZswmWpxiw8ynObuCdYiY8sup/XnDOJMHF57IOpc157Q3Ptoheufp+CAtZ8Tr0SVMLcc9iPoyOJkx2WDV02qkimdlzKP4c3btA+Bdo6DnMAaAdwIDAQAB";
export const QA_EXTENSION_ID = createHash("sha256")
  .update(Buffer.from(QA_CHROME_PUBLIC_KEY, "base64"))
  .digest("hex")
  .slice(0, 32)
  .replace(/[0-9a-f]/gu, (nibble) => "abcdefghijklmnop"[parseInt(nibble, 16)]!);
// The existing native QA guard requires an RFC4122 UUIDv4 build-parent name.
export const QA_ID = /^[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/u;
export interface PrototypeIdentity {
  version: 1;
  qaId: string;
  packageName: string;
  publisher: string;
  packageVersion: "1.0.0.0";
  architecture: "x64";
  minVersion: "10.0.19045.0";
  unsignedInstallMinimum: "Windows 11";
  installScope: "all-users-executable-unsigned-qa";
  executable: "MusicMuteMsixProbe.exe";
  hostExecutable: "MusicMuteMsixChromeHost.exe";
  alias: string;
  hostNames: { fixed: string; alias: string };
  extensionId: typeof QA_EXTENSION_ID;
  namespaceProfile?: "unvirtualized-candidate-v1";
  dataCohort?: string;
  dataRole?: "gui" | "worker";
}
export interface PrototypeNamespaceCandidate {
  namespaceProfile: "unvirtualized-candidate-v1";
  dataCohort: string;
  dataRole: "gui" | "worker";
}
export function prototypeIdentity(
  qaId: string,
  candidate?: PrototypeNamespaceCandidate,
): PrototypeIdentity {
  if (typeof qaId !== "string" || !QA_ID.test(qaId))
    throw new Error("MSIX_QA_ID_INVALID");
  if (
    candidate !== undefined &&
    (!candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join() !==
        "dataCohort,dataRole,namespaceProfile" ||
      candidate.namespaceProfile !== "unvirtualized-candidate-v1" ||
      !QA_ID.test(candidate.dataCohort) ||
      !["gui", "worker"].includes(candidate.dataRole))
  )
    throw new Error("MSIX_QA_NAMESPACE_CANDIDATE_INVALID");
  return {
    version: 1,
    qaId,
    packageName: `MusicMute.S03.QA.${qaId}`,
    publisher: `CN=MusicMute-S03-QA-${candidate?.dataCohort ?? qaId}, ${UNSIGNED_OID}`,
    packageVersion: "1.0.0.0",
    architecture: "x64",
    minVersion: "10.0.19045.0",
    unsignedInstallMinimum: "Windows 11",
    installScope: "all-users-executable-unsigned-qa",
    executable: "MusicMuteMsixProbe.exe",
    hostExecutable: "MusicMuteMsixChromeHost.exe",
    alias: `musicmute-s03-${qaId}.exe`,
    hostNames: {
      fixed: `com.musicmute.local.msixqa.${qaId}.fixed`,
      alias: `com.musicmute.local.msixqa.${qaId}.alias`,
    },
    extensionId: QA_EXTENSION_ID,
    ...candidate,
  };
}
export function parsePrototypeIdentity(value: unknown): PrototypeIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("MSIX_QA_IDENTITY_INVALID");
  const supplied = value as PrototypeIdentity;
  const expected = prototypeIdentity(
    supplied.qaId,
    supplied.namespaceProfile === undefined
      ? undefined
      : {
          namespaceProfile: supplied.namespaceProfile,
          dataCohort: supplied.dataCohort!,
          dataRole: supplied.dataRole!,
        },
  );
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return JSON.stringify(item);
    if (item && typeof item === "object")
      return JSON.stringify(
        Object.fromEntries(
          Object.entries(item)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, JSON.parse(canonical(child))]),
        ),
      );
    return JSON.stringify(item);
  };
  if (canonical(value) !== canonical(expected))
    throw new Error("MSIX_QA_IDENTITY_INVALID");
  return expected;
}
export function prototypeBuildRelativeDirectory(
  identity: PrototypeIdentity,
): string {
  const id = parsePrototypeIdentity(identity).qaId;
  const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  const parent = `MusicMuteAcceptance-${uuid}`;
  if (
    !/^MusicMuteAcceptance-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      parent,
    )
  )
    throw new Error("MSIX_QA_BUILD_GEOMETRY_INVALID");
  return `${parent}/native-build`;
}
export function manifestXml(identity: PrototypeIdentity): string {
  const plan = parsePrototypeIdentity(identity);
  const candidate = plan.namespaceProfile === "unvirtualized-candidate-v1";
  const behavior = candidate ? "win32App" : "packagedClassicApp";
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:uap5="http://schemas.microsoft.com/appx/manifest/uap/windows10/5" xmlns:desktop4="http://schemas.microsoft.com/appx/manifest/desktop/windows10/4" xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"${candidate ? ' xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"' : ""} IgnorableNamespaces="uap uap5 desktop4 uap10 rescap${candidate ? " desktop6" : ""}">
  <Identity Name="${plan.packageName}" Publisher="${plan.publisher}" Version="${plan.packageVersion}" ProcessorArchitecture="x64" />
  <Properties><DisplayName>MusicMute S03 isolated QA</DisplayName><PublisherDisplayName>MusicMute QA</PublisherDisplayName><Logo>Assets\\StoreLogo.png</Logo>${candidate ? "<desktop6:RegistryWriteVirtualization>disabled</desktop6:RegistryWriteVirtualization><desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>" : ""}</Properties>
  <Resources><Resource Language="en-us" /></Resources>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="${plan.minVersion}" MaxVersionTested="10.0.26200.0" /></Dependencies>
  <Applications>
    <Application Id="Probe" Executable="${plan.executable}" uap10:RuntimeBehavior="${behavior}" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="MusicMute S03 isolated QA" Description="Disposable namespace and native messaging test; no product data" BackgroundColor="transparent" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" />
    </Application>
    <Application Id="ChromeHost" Executable="${plan.hostExecutable}" uap10:RuntimeBehavior="${behavior}" uap10:TrustLevel="mediumIL" desktop4:Subsystem="console" desktop4:SupportsMultipleInstances="true">
      <uap:VisualElements AppListEntry="none" DisplayName="MusicMute S03 QA Chrome host" Description="Isolated binary stdio test" BackgroundColor="transparent" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" />
      <Extensions><uap5:Extension Category="windows.appExecutionAlias" Executable="${plan.hostExecutable}" uap10:RuntimeBehavior="${behavior}" uap10:TrustLevel="mediumIL"><uap5:AppExecutionAlias desktop4:Subsystem="console"><uap5:ExecutionAlias Alias="${plan.alias}" /></uap5:AppExecutionAlias></uap5:Extension></Extensions>
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" />${candidate ? '<rescap:Capability Name="unvirtualizedResources" />' : ""}</Capabilities>
</Package>
`;
}
export function configHeader(identity: PrototypeIdentity): string {
  const p = parsePrototypeIdentity(identity);
  return `#pragma once
#define MM_QA_ID L"${p.qaId}"
#define MM_QA_NAME L"${p.packageName}"
#define MM_QA_PUBLISHER L"${p.publisher}"
#define MM_QA_ALIAS L"${p.alias}"
#define MM_QA_HOST_FIXED L"${p.hostNames.fixed}"
#define MM_QA_HOST_ALIAS L"${p.hostNames.alias}"
#define MM_QA_ORIGIN L"chrome-extension://${p.extensionId}/"
#define MM_QA_NAMESPACE_PROFILE L"${p.namespaceProfile ?? "packaged-classic-v1"}"
#define MM_QA_DATA_COHORT L"${p.dataCohort ?? p.qaId}"
#define MM_QA_DATA_ROLE L"${p.dataRole ?? "single"}"
#define MM_QA_IMMUTABLE_MANIFEST_SHA256 "${sha256(Buffer.from(packageNativeManifest(p)))}"
`;
}
export function packageNativeManifest(identity: PrototypeIdentity): string {
  const p = parsePrototypeIdentity(identity);
  return (
    JSON.stringify(
      {
        name: `${p.hostNames.fixed}.immutable`,
        description: "MusicMute S03 immutable packaged QA host",
        path: p.hostExecutable,
        type: "stdio",
        allowed_origins: [`chrome-extension://${p.extensionId}/`],
      },
      null,
      2,
    ) + "\n"
  );
}
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** A Store-origin observation is only one conjunct of production trust. */
export function productionStoreOriginAllowed(signatureKind: number): boolean {
  return signatureKind === 3;
}
