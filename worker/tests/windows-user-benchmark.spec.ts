import { describe, expect, it } from "vitest";
import { assertWindowsBenchmarkReportDestination } from "../src/platform/windows/user-benchmark.js";
import { createWindowsServiceLayout } from "../src/platform/windows/service-definition.js";

const layout = createWindowsServiceLayout();
describe("Windows benchmark report destinations", () => {
  it("allows external reports and uniquely named private state reports", () => {
    for (const path of [
      "C:\\MusicMuteBuild\\benchmark.json",
      "D:\\results\\benchmark.json",
      `${layout.stateRoot}\\benchmark-12345678-1234-1234-1234-123456789abc.json`,
    ])
      expect(() =>
        assertWindowsBenchmarkReportDestination(layout, path),
      ).not.toThrow();
  });

  it("rejects release and service changes, including case variants", () => {
    for (const path of [
      `${layout.releasesRoot}\\version\\extra.json`,
      `${layout.serviceRoot}\\extra.json`,
      layout.configPath.toLowerCase(),
      `${layout.stateRoot}\\active-release.json`,
    ])
      expect(() =>
        assertWindowsBenchmarkReportDestination(layout, path),
      ).toThrow("installation files");
  });

  it("rejects traversal, network paths and alternate data streams", () => {
    for (const path of [
      "C:\\results\\..\\report.json",
      "\\\\server\\share\\report.json",
      "C:\\results\\file.txt:report.json",
      "C:report.json",
    ])
      expect(() =>
        assertWindowsBenchmarkReportDestination(layout, path),
      ).toThrow("normalized local");
  });
});
