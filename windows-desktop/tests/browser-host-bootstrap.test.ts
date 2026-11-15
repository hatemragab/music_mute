import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const hostBoundary = vi.hoisted(() => vi.fn());
vi.mock("../src/main/host-context.js", () => ({
  openWindowsHost: hostBoundary,
}));
vi.mock("../src/main/browser/registration.js", () => ({
  loadBrowserIntegrationManifest: vi.fn(async () => ({
    extensionId: "acmgefmmndomcpdlgnafkjbgobinllep",
  })),
}));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
const roots: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "arch", architecture);
  hostBoundary.mockReset();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function start(value: unknown) {
  const resources = await mkdtemp(
    join(tmpdir(), "musicmute-browser-build-fixture-"),
  );
  roots.push(resources);
  await writeFile(join(resources, "desktop-build.json"), JSON.stringify(value));
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  Object.defineProperty(process, "arch", { ...architecture, value: "x64" });
  const { runBrowserHost } = await import("../src/agent/browser-host.js");
  return {
    resources,
    run: () =>
      runBrowserHost([
        "--origin",
        "chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/",
        "--resources",
        resources,
      ]),
  };
}
it("passes actual bounded desktop build metadata to Host before opening any native/browser authority (injected Host boundary)", async () => {
  const fixture = await start({
    version: 1,
    appVersion: "0.9.1",
    buildNumber: 73,
  });
  hostBoundary.mockRejectedValue(new Error("FIXTURE_HOST_BOUNDARY"));
  await expect(fixture.run()).rejects.toThrow("FIXTURE_HOST_BOUNDARY");
  expect(hostBoundary).toHaveBeenCalledExactlyOnceWith(
    fixture.resources,
    "0.9.1",
    73,
  );
});
it("rejects missing/invalid approved build before opening Host instead of guessing build one", async () => {
  for (const value of [
    { version: 1, appVersion: "0.9.1" },
    { version: 1, appVersion: "0.9.1", buildNumber: 0 },
    { version: 1, appVersion: "0.9.1", buildNumber: 73, extra: true },
  ]) {
    const fixture = await start(value);
    await expect(fixture.run()).rejects.toThrow("PACKAGED_TRUST_INVALID");
  }
  expect(hostBoundary).not.toHaveBeenCalled();
});
