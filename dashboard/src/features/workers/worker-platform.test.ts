import { describe, it, expect } from "vitest";
import { createDashboardFixture } from "@/test/dashboard-fixtures";
import {
  workerPlatformLabel,
  workerInstallationProfile,
} from "./worker-platform";
describe("Windows worker presentation is identity-aware", () => {
  it("distinguishes consumer from omitted legacy/service identity without fabricating qualification", () => {
    const machine = createDashboardFixture().workerMachine;
    expect(workerInstallationProfile(machine)).toMatchObject({
      label: "Windows service (legacy profile)",
      consumer: false,
    });
    machine.runtime = {
      ...machine.runtime!,
      installationProfile: "windows-user",
    };
    expect(workerInstallationProfile(machine)).toMatchObject({
      label: "Windows per-user worker",
      consumer: true,
    });
    expect(workerInstallationProfile(machine).detail).toContain("build 19045");
    expect(workerInstallationProfile(machine).detail).toContain(
      "Windows logout",
    );
    expect(workerInstallationProfile(machine).detail).toContain("DirectML");
    expect(machine.capabilities[0]?.maxSlots).toBe(1);
  });
  it("does not convert future unknown profiles or mismatched Mac reports into a Windows consumer", () => {
    const machine = createDashboardFixture().workerMachine;
    machine.runtime = {
      ...machine.runtime!,
      installationProfile: "future-profile" as never,
    };
    expect(workerInstallationProfile(machine)).toMatchObject({
      label: "Unrecognized installation profile",
      consumer: false,
    });
    machine.runtime.installationProfile = "windows-user";
    machine.capabilities = [
      {
        ...machine.capabilities[0]!,
        platform: "darwin-arm64",
        provider: "mps",
      },
    ];
    expect(workerInstallationProfile(machine)).toMatchObject({
      label: "Profile/platform mismatch",
      consumer: false,
    });
    delete machine.runtime.installationProfile;
    expect(workerInstallationProfile(machine).label).toBe("macOS user worker");
  });
  it("keeps unreported and unsupported platform identities explicit", () => {
    const machine = createDashboardFixture().workerMachine;
    machine.capabilities = [];
    machine.runtime = null;
    expect(workerInstallationProfile(machine)).toMatchObject({
      label: "Installation profile not reported",
      consumer: false,
    });
    expect(workerPlatformLabel("windows-amd64")).toBe("Windows x64");
    expect(workerPlatformLabel("darwin-arm64")).toBe("macOS ARM64");
    expect(workerPlatformLabel("linux-arm64")).toBe("Unknown platform");
  });
});
