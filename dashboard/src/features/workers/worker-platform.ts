import type { WorkerMachine } from "./worker-types";

export function workerPlatformLabel(platform: unknown): string {
  return platform === "darwin-arm64"
    ? "macOS ARM64"
    : platform === "windows-amd64"
      ? "Windows x64"
      : "Unknown platform";
}

/** Missing Windows profile is the compatible service path; never guess consumer identity. */
export function workerInstallationProfile(
  machine: Pick<WorkerMachine, "capabilities" | "runtime">,
): { label: string; detail: string; consumer: boolean } {
  const platforms = new Set(
    machine.capabilities.map((capability) => capability.platform),
  );
  const profile: unknown = machine.runtime?.installationProfile;
  if (
    profile === "windows-user" &&
    platforms.size === 1 &&
    platforms.has("windows-amd64")
  )
    return {
      label: "Windows per-user worker",
      consumer: true,
      detail:
        "Windows 10 22H2 x64 (build 19045) or Windows 11 x64; qualified DirectML GPU required. Runs under the logged-in Windows user and ends at Windows logout.",
    };
  if (profile !== undefined && profile !== null)
    return {
      label:
        profile === "windows-user"
          ? "Profile/platform mismatch"
          : "Unrecognized installation profile",
      consumer: false,
      detail:
        "Reported identity is not recognized as a Windows per-user worker. Inspect the installation and approved capabilities before changing policy.",
    };
  if (platforms.size === 1 && platforms.has("windows-amd64"))
    return {
      label: "Windows service (legacy profile)",
      consumer: false,
      detail:
        "The runtime report omits the per-user profile. This is the compatible service installation; do not deliver a consumer artifact to it.",
    };
  if (platforms.size === 1 && platforms.has("darwin-arm64"))
    return {
      label: "macOS user worker",
      consumer: false,
      detail:
        "Existing macOS worker installation. Machine policy and credentials remain independent of the app account session.",
    };
  return {
    label: "Installation profile not reported",
    consumer: false,
    detail:
      "No single recognized qualified platform is available in this report.",
  };
}
