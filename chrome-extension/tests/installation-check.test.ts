import { describe, expect, it, vi } from "vitest";
import { checkInstallation } from "../src/companion/installation-check";
import { isInstallationCheck } from "../src/shared/installation-check";
import type { LocalConfig } from "../src/companion/config";

const id = "a".repeat(64);
describe("explicit installation diagnostics", () => {
  it("publishes ordered component progress and a bounded successful result", async () => {
    const progress = vi.fn();
    const inspect = {
      runtime: vi.fn(async () => {}),
      model: vi.fn(async () => {}),
      youtube_tools: vi.fn(async () => {}),
    };
    const result = await checkInstallation(
      {} as LocalConfig,
      id,
      new AbortController().signal,
      progress,
      inspect,
    );
    expect(result.state).toBe("passed");
    expect(result.checks.map((check) => check.state)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    expect(
      progress.mock.calls.every(([value]) => isInstallationCheck(value)),
    ).toBe(true);
    expect(progress.mock.calls[0]![0].state).toBe("running");
    expect(inspect.runtime.mock.invocationCallOrder[0]).toBeLessThan(
      inspect.model.mock.invocationCallOrder[0]!,
    );
  });
  it("does not execute probes after runtime integrity failure and strips private errors", async () => {
    const inspect = {
      runtime: vi.fn(async () => {
        throw new Error("private /path?token=secret");
      }),
      model: vi.fn(async () => {}),
      youtube_tools: vi.fn(async () => {}),
    };
    const result = await checkInstallation(
      {} as LocalConfig,
      id,
      new AbortController().signal,
      () => {},
      inspect,
    );
    expect(result.state).toBe("failed");
    expect(result.checks[0]?.error_code).toBe("INSTALLATION_CHECK_FAILED");
    expect(inspect.model).not.toHaveBeenCalled();
    expect(inspect.youtube_tools).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(isInstallationCheck(result)).toBe(true);
  });
  it("cancels before running any probe", async () => {
    const controller = new AbortController();
    controller.abort();
    const inspect = {
      runtime: vi.fn(async () => {}),
      model: vi.fn(async () => {}),
      youtube_tools: vi.fn(async () => {}),
    };
    const result = await checkInstallation(
      {} as LocalConfig,
      id,
      controller.signal,
      () => {},
      inspect,
    );
    expect(result.checks[0]?.error_code).toBe("CANCELLED");
    expect(inspect.runtime).not.toHaveBeenCalled();
  });
});
