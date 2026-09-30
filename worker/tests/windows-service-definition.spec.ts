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
    expect(xml).not.toContain("STORAGE_");
  });

  it("renders a one-shot DirectML qualification as LocalService", () => {
    const layout = createWindowsServiceLayout(
      "C:\\ProgramData\\MusicMute Test",
    );
    const release = createWindowsReleaseLayout(layout, "0.1.0-win.1");
    const xml = renderWinSWConfig(layout, release, {
      fixturePath: `${layout.stateRoot}\\qualification-fixture.wav`,
      fixtureSha256: "b".repeat(64),
      reportPath: `${layout.stateRoot}\\qualification.json`,
    });

    expect(xml).toContain("runtime\\python\\python.exe");
    expect(xml).toContain("musicmute_engine.qualification");
    expect(xml).toContain("musicmute_engine.windows_service_task");
    expect(xml).toContain("--directml-device-id 0");
    expect(xml).toContain("<startmode>Manual</startmode>");
    expect(xml).toContain("<domain>NT AUTHORITY</domain>");
    expect(xml).toContain("<user>LocalService</user>");
    expect(xml).not.toContain("<delayedAutoStart/>");
    expect(xml).not.toContain('action="restart"');
    expect(xml).not.toContain("state\\runtime.json");
  });

  it("runs repeated benchmarks with LocalService, private scratch and fixed DirectML grouping", () => {
    const layout = createWindowsServiceLayout();
    const release = createWindowsReleaseLayout(layout, "0.1.0-test");
    const task = {
      fixturePath: `${layout.stateRoot}\\input.mp3`,
      fixtureSha256: "a".repeat(64),
      reportPath: `${layout.stateRoot}\\qualification-test.json`,
      benchmark: {
        recipeId: "kim-vocals-v2" as const,
        warmupRuns: 1,
        measuredRuns: 3,
      },
    };
    const xml = renderWinSWConfig(layout, release, task);
    expect(xml).toContain(
      "musicmute_engine.windows_service_task musicmute_engine.benchmark_file --",
    );
    expect(xml).toContain("--group-size 1");
    expect(xml).toContain("state\\tmp\\qualification-test");
    expect(xml).toContain('<env name="PYTHONDONTWRITEBYTECODE" value="1"/>');
    expect(xml).not.toContain("state\\runtime.json");
    expect(() =>
      renderWinSWConfig(layout, release, {
        ...task,
        benchmark: { ...task.benchmark, measuredRuns: 1 },
      }),
    ).toThrow("benchmark settings");
  });

  it("rejects roots and versions that can escape the installation", () => {
    expect(() => createWindowsServiceLayout("C:\\")).toThrow("unsafe");
    const layout = createWindowsServiceLayout();
    expect(() => createWindowsReleaseLayout(layout, "..\\outside")).toThrow(
      "version is invalid",
    );
    const release = createWindowsReleaseLayout(layout, "0.1.0");
    expect(() =>
      renderWinSWConfig(layout, release, {
        fixturePath: `${layout.stateRoot}\\fixture.wav`,
        fixtureSha256: "invalid",
        reportPath: `${layout.stateRoot}\\report.json`,
      }),
    ).toThrow("fixture digest is invalid");
  });

  it("runs all-recipe capacity measurement inside the owned LocalService task", () => {
    const layout = createWindowsServiceLayout();
    const release = createWindowsReleaseLayout(layout, "0.1.0-test");
    const task = {
      fixturePath: `${layout.stateRoot}\\input.wav`,
      fixtureSha256: "a".repeat(64),
      reportPath: `${layout.stateRoot}\\qualification-capacity.json`,
      capacity: { warmupRuns: 1, measuredRuns: 3 },
    };
    const xml = renderWinSWConfig(layout, release, task);
    expect(xml).toContain(
      "musicmute_engine.windows_service_task musicmute_engine.capacity_benchmark --",
    );
    expect(xml).toContain("state\\tmp\\qualification-capacity");
    expect(xml).not.toContain("--recipe-id");
    expect(() =>
      renderWinSWConfig(layout, release, {
        ...task,
        capacity: { warmupRuns: 0, measuredRuns: 3 },
      }),
    ).toThrow("benchmark settings");
  });
});
