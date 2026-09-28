import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { workerVersions } from "../src/cli/version.js";
import {
  createMacUserDirectories,
  createMacUserLayout,
} from "../src/platform/macos/user-paths.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "worker-version-"));
  roots.push(home);
  const packagePath = join(home, "package.json");
  await writeFile(packagePath, JSON.stringify({ version: "0.1.0-rc.1" }));
  const layout = createMacUserLayout(home);
  await createMacUserDirectories(layout);
  return { home, packagePath, layout, platform: "darwin" as const };
}
it("reports CLI version before enrollment without reading credentials", async () => {
  const f = await fixture();
  expect(await workerVersions(f)).toMatchObject({
    cliVersion: "0.1.0-rc.1",
    runtimeVersion: null,
    runtimeState: "not-installed",
  });
});
it("distinguishes the managed runtime from the npm CLI", async () => {
  const f = await fixture();
  await mkdir(join(f.layout.releasesRoot, "0.1.0-mvp.45"));
  await symlink("releases/0.1.0-mvp.45", f.layout.currentLink);
  await writeFile(
    f.layout.installationStatePath,
    JSON.stringify({ releaseVersion: "0.1.0-mvp.45" }),
    { mode: 0o600 },
  );
  expect(await workerVersions(f)).toMatchObject({
    cliVersion: "0.1.0-rc.1",
    runtimeVersion: "0.1.0-mvp.45",
    runtimeState: "installed",
  });
  await writeFile(
    f.layout.installationStatePath,
    JSON.stringify({ releaseVersion: "0.1.0-mvp.44" }),
  );
  expect(await workerVersions(f)).toMatchObject({
    runtimeVersion: null,
    runtimeState: "unavailable",
  });
});
it("does not follow arbitrary runtime links or fail on unsupported platforms", async () => {
  const f = await fixture();
  await symlink("/private/untrusted", f.layout.currentLink);
  expect(await workerVersions(f)).toMatchObject({
    runtimeState: "unavailable",
  });
  expect(await workerVersions({ ...f, platform: "linux" })).toMatchObject({
    runtimeState: "unsupported",
  });
});
