import { describe, expect, it } from "vitest";
import {
  createWindowsReleaseLayout,
  createWindowsServiceLayout,
  renderWinSWConfig,
  WINDOWS_SERVICE_ACCOUNT,
} from "../src/platform/windows/service-definition.js";

describe("Windows service definition", () => {
  it("uses private versioned executables, LocalService and bounded state", () => {
    const layout = createWindowsServiceLayout(
      "C:\\ProgramData\\MusicMute Test",
    );
    const release = createWindowsReleaseLayout(layout, "0.1.0-win.1");
    const xml = renderWinSWConfig(layout, release);
    expect(xml).toContain("MusicMuteWorker");
    expect(WINDOWS_SERVICE_ACCOUNT).toBe("NT AUTHORITY\\LocalService");
    expect(xml).toContain("<domain>NT AUTHORITY</domain>");
    expect(xml).toContain("<user>LocalService</user>");
    expect(xml).toContain("releases\\0.1.0-win.1\\runtime\\node\\node.exe");
    expect(xml).toContain("state\\cache\\numba");
    expect(xml).toContain("state\\tmp");
    expect(xml).toContain("<startmode>Automatic</startmode>");
    expect(xml).toContain("<delayedAutoStart/>");
    expect(xml).not.toContain("<username>");
    expect(xml).not.toContain("<delayedAutoStart>true");
    expect(xml).not.toContain("password");
    expect(xml).not.toContain("AWS_");
  });

  it("rejects roots and versions that can escape the installation", () => {
    expect(() => createWindowsServiceLayout("C:\\")).toThrow("unsafe");
    const layout = createWindowsServiceLayout();
    expect(() => createWindowsReleaseLayout(layout, "..\\outside")).toThrow(
      "version is invalid",
    );
  });
});
