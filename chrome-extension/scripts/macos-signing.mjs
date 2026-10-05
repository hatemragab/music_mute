import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const teamPattern = /^[A-Z0-9]{10}$/;
const certificatePattern = /^[A-F0-9]{40}$/;
const authorityPattern =
  /^Developer ID Application: [^\r\n]+ \(([A-Z0-9]{10})\)$/;
const tools = { timeout: 30_000, maxBuffer: 256 * 1024 };

/** Release mode is explicit; unknown or repeated arguments never select it. */
export function parsePackageMode(args) {
  if (args.length === 0) return { release: false };
  if (args.length === 1 && args[0] === "--release") return { release: true };
  throw new Error("INVALID_PACKAGE_OPTIONS");
}

/** Apple requires a macOS 10.9+ SDK for every included Mach-O slice. */
export function assertNotarizationLoadCommands(output) {
  if (typeof output !== "string" || Buffer.byteLength(output) > 2 * 1024 * 1024)
    throw new Error("RELEASE_LOAD_COMMANDS_INVALID");
  const sdkCommands = [
    ...output.matchAll(
      /cmd LC_(BUILD_VERSION|VERSION_MIN_MACOSX)\s+cmdsize \d+\s+([\s\S]*?)(?=Load command \d+|$)/g,
    ),
  ];
  if (sdkCommands.length === 0) throw new Error("RELEASE_MACOS_SDK_UNVERIFIED");
  for (const command of sdkCommands) {
    const sdk = command[2].match(/\bsdk (\d+)\.(\d+)(?:\.\d+)?\s/);
    if (
      !sdk ||
      (command[1] === "BUILD_VERSION" &&
        !/\bplatform (?:1|macos)\s/.test(command[2])) ||
      Number(sdk[1]) < 10 ||
      (Number(sdk[1]) === 10 && Number(sdk[2]) < 9)
    )
      throw new Error("RELEASE_MACOS_SDK_UNSUPPORTED");
  }
}

/** Public certificate metadata only. No keychain items or private keys are exported. */
export function parseDeveloperIdIdentities(output) {
  if (typeof output !== "string" || Buffer.byteLength(output) > tools.maxBuffer)
    throw new Error("SIGNING_IDENTITY_OUTPUT_INVALID");
  const identities = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*\d+\) ([A-Fa-f0-9]{40}) "([^"\r\n]+)"\s*$/.exec(line);
    if (!match) continue;
    const authority = authorityPattern.exec(match[2]);
    if (authority)
      identities.push({
        identity: match[1].toUpperCase(),
        authority: match[2],
        teamIdentifier: authority[1],
      });
  }
  return identities;
}

export async function resolveSigningConfiguration({
  release,
  identity,
  exec = run,
}) {
  if (!release)
    return {
      release: false,
      identity: identity ?? "-",
      signing:
        identity == null || identity === "-"
          ? "AD_HOC_LOCAL"
          : "DEVELOPER_ID_LOCAL_NO_NOTARIZATION",
    };
  if (
    typeof identity !== "string" ||
    (!certificatePattern.test(identity.toUpperCase()) &&
      !authorityPattern.test(identity))
  )
    throw new Error("RELEASE_REQUIRES_DEVELOPER_ID_APPLICATION_IDENTITY");
  let result;
  try {
    result = await exec(
      "/usr/bin/security",
      ["find-identity", "-v", "-p", "codesigning"],
      tools,
    );
  } catch {
    throw new Error("RELEASE_SIGNING_IDENTITY_LOOKUP_FAILED");
  }
  const matches = parseDeveloperIdIdentities(result.stdout).filter(
    (candidate) =>
      candidate.identity === identity.toUpperCase() ||
      candidate.authority === identity,
  );
  // A certificate renewed under the same common name must be selected by fingerprint.
  if (matches.length !== 1)
    throw new Error("RELEASE_SIGNING_IDENTITY_NOT_UNIQUE_OR_UNAVAILABLE");
  return {
    release: true,
    ...matches[0],
    signing: "DEVELOPER_ID_DISTRIBUTION",
  };
}

/** DMGs are data containers; runtime/entitlements belong to their enclosed code. */
export function signingArguments(
  config,
  { entitlements, kind = "binary" } = {},
) {
  if (!["binary", "app", "dmg"].includes(kind))
    throw new Error("INVALID_SIGNING_TARGET_KIND");
  if (kind === "dmg" && entitlements)
    throw new Error("DMG_CANNOT_DECLARE_RUNTIME_ENTITLEMENTS");
  if (config.release) assertReleaseConfiguration(config);
  const args = [
    "--force",
    "--sign",
    config.identity,
    config.release ? "--timestamp" : "--timestamp=none",
  ];
  if (kind !== "dmg") args.push("--options", "runtime");
  if (entitlements) args.push("--entitlements", entitlements);
  return args;
}

function assertReleaseConfiguration(config) {
  if (
    config.release !== true ||
    !certificatePattern.test(config.identity ?? "") ||
    !teamPattern.test(config.teamIdentifier ?? "") ||
    authorityPattern.exec(config.authority ?? "")?.[1] !== config.teamIdentifier
  )
    throw new Error("RELEASE_SIGNING_CONFIGURATION_INVALID");
}

/** Inspect the embedded XML projection, including non-Boolean debug declarations. */
export function assertReleaseEntitlements(output) {
  if (
    typeof output !== "string" ||
    Buffer.byteLength(output) > tools.maxBuffer ||
    Buffer.from(output).some(
      (byte) => ![9, 10, 13].includes(byte) && (byte < 32 || byte > 126),
    )
  )
    throw new Error("RELEASE_EMBEDDED_ENTITLEMENTS_INVALID");
  const xml = output.trim();
  if (!xml) return;
  if (
    xml.includes("bplist00") ||
    !/^(?:<\?xml\b[^>]*\?>\s*)?(?:<!DOCTYPE\b[^>]*>\s*)?<plist\b/.test(xml) ||
    !xml.endsWith("</plist>")
  )
    throw new Error("RELEASE_EMBEDDED_ENTITLEMENTS_INVALID");
  const keys = [...xml.matchAll(/<key>([^<]*)<\/key>/g)].map((match) =>
    match[1].replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, value) => {
      const code =
        value.startsWith("x") || value.startsWith("X")
          ? Number.parseInt(value.slice(1), 16)
          : Number.parseInt(value, 10);
      return code <= 0x7f ? String.fromCharCode(code) : "?";
    }),
  );
  if (keys.includes("com.apple.security.get-task-allow"))
    throw new Error("RELEASE_DEBUG_ENTITLEMENT_FORBIDDEN");
}

/** Interpret output only after codesign has verified an Apple-anchored requirement. */
export function assertDeveloperIdDisplay(
  output,
  config,
  { kind = "binary" } = {},
) {
  assertReleaseConfiguration(config);
  if (!["binary", "app", "dmg"].includes(kind))
    throw new Error("INVALID_SIGNING_TARGET_KIND");
  if (typeof output !== "string" || Buffer.byteLength(output) > tools.maxBuffer)
    throw new Error("RELEASE_SIGNATURE_DETAILS_INVALID");
  const lines = output.split(/\r?\n/);
  const authorities = lines
    .filter((line) => line.startsWith("Authority="))
    .map((line) => line.slice("Authority=".length));
  const fields = (key) =>
    lines
      .filter((line) => line.startsWith(`${key}=`))
      .map((line) => line.slice(key.length + 1));
  const teams = fields("TeamIdentifier");
  const timestamps = fields("Timestamp");
  const hardened = lines.some((line) =>
    /^CodeDirectory\s.*\bflags=0x([A-Fa-f0-9]+)\(.*\bruntime\b.*\)/.test(line),
  );
  if (
    authorities.length !== 3 ||
    authorities[0] !== config.authority ||
    !/^Developer ID Certification Authority(?: G[0-9]+)?$/.test(
      authorities[1],
    ) ||
    !/^Apple Root CA(?: - G[0-9]+)?$/.test(authorities[2]) ||
    teams.length !== 1 ||
    teams[0] !== config.teamIdentifier
  )
    throw new Error("RELEASE_SIGNATURE_DEVELOPER_ID_MISMATCH");
  if (
    timestamps.length !== 1 ||
    !timestamps[0].trim() ||
    /^(?:none|not available|unknown)$/i.test(timestamps[0].trim()) ||
    fields("Signed Time").length !== 0
  )
    throw new Error("RELEASE_SIGNATURE_SECURE_TIMESTAMP_MISSING");
  // Check the actual flag bit as well as codesign's textual annotation.
  const directory = lines.find((line) => line.startsWith("CodeDirectory "));
  const bits = directory?.match(/\bflags=0x([A-Fa-f0-9]+)/)?.[1];
  if (
    kind !== "dmg" &&
    (!hardened || !(Number.parseInt(bits ?? "0", 16) & 0x10000))
  )
    throw new Error("RELEASE_SIGNATURE_HARDENED_RUNTIME_MISSING");
  return {
    authority: config.authority,
    team_identifier: config.teamIdentifier,
    secure_timestamp: true,
    hardened_runtime: kind !== "dmg",
  };
}

export async function verifyDeveloperIdSignature(
  path,
  config,
  { exec = run, kind = "binary" } = {},
) {
  assertReleaseConfiguration(config);
  if (!["binary", "app", "dmg"].includes(kind))
    throw new Error("INVALID_SIGNING_TARGET_KIND");
  const requirement =
    '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "' +
    config.teamIdentifier +
    '"';
  let details;
  let entitlements;
  try {
    await exec(
      "/usr/bin/codesign",
      [
        "--verify",
        "--strict",
        "--all-architectures",
        ...(kind === "app" ? ["--deep"] : []),
        "--test-requirement",
        requirement,
        path,
      ],
      { ...tools, timeout: kind === "app" ? 120_000 : tools.timeout },
    );
    details = await exec(
      "/usr/bin/codesign",
      ["--display", "--verbose=4", path],
      tools,
    );
    if (kind !== "dmg")
      entitlements = await exec(
        "/usr/bin/codesign",
        ["--display", "--entitlements", "-", "--xml", path],
        tools,
      );
  } catch {
    // Do not publish arbitrary keychain/tool stderr in build summaries.
    throw new Error("RELEASE_SIGNATURE_VERIFICATION_FAILED");
  }
  if (kind !== "dmg") assertReleaseEntitlements(entitlements.stdout ?? "");
  return assertDeveloperIdDisplay(
    `${details.stdout ?? ""}\n${details.stderr ?? ""}`,
    config,
    { kind },
  );
}
