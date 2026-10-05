import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveDiagnosticIdentity,
  sanitizeDiagnosticIdentity,
} from "../src/companion/diagnostic-identity.js";
import { Diagnostics } from "../src/companion/diagnostics.js";
import { MODEL_SHA256 } from "../src/companion/local-provider.js";
import { VERSION } from "../src/shared/protocol.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: vi.fn(actual.readSync),
    openSync: vi.fn(actual.openSync),
    lstatSync: vi.fn(actual.lstatSync),
  };
});

const roots: string[] = [];
const inventory = {
  schema_version: 1,
  architecture: "arm64",
  includes_model_weights: false,
  includes_worker_state: false,
  files: [
    { path: "/private/fixture-do-not-export", secret: "fixture-private-token" },
  ],
};
function fixture(): { resources: string; path: string } {
  const resources = mkdtempSync(join(tmpdir(), "musicmute-identity-test-"));
  roots.push(resources);
  chmodSync(resources, 0o755);
  const path = join(resources, "bundle-audit.json");
  writeFileSync(path, JSON.stringify(inventory), { mode: 0o644 });
  return { resources, path };
}
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.readSync).mockReset().mockImplementation(actual.readSync);
  vi.mocked(fs.openSync).mockReset().mockImplementation(actual.openSync);
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(actual.lstatSync);
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("recorder build identity", () => {
  it("uses current component pins and fingerprints only a safe packaged inventory", () => {
    expect(resolveDiagnosticIdentity({})).toEqual({
      software_version: VERSION,
      runtime_scope: "DEVELOPMENT",
      expected_model_sha256: MODEL_SHA256,
    });
    const { resources } = fixture();
    const identity = resolveDiagnosticIdentity({ app_resources: resources });
    expect(identity).toEqual({
      software_version: VERSION,
      runtime_scope: "PACKAGED_APP",
      expected_model_sha256: MODEL_SHA256,
      package_inventory_sha256: createHash("sha256")
        .update(JSON.stringify(inventory))
        .digest("hex"),
    });
    expect(fs.openSync).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(identity)).not.toContain("/private/fixture");
    expect(JSON.stringify(identity)).not.toContain("fixture-private-token");
  });

  it("retains safe historical versions and model pins while stripping unrelated fields", () => {
    const historical = {
      software_version: "0.0.1-alpha+fixture",
      runtime_scope: "DEVELOPMENT",
      expected_model_sha256: "a".repeat(64),
    };
    // The version grammar permits one prerelease/build marker, with safe suffix scalars only.
    expect(sanitizeDiagnosticIdentity(historical)).toBeUndefined();
    historical.software_version = "0.0.1-alpha.fixture";
    expect(
      sanitizeDiagnosticIdentity({
        ...historical,
        private_path: "/private/no-export",
      }),
    ).toEqual(historical);
    expect(
      sanitizeDiagnosticIdentity({
        ...historical,
        package_inventory_sha256: null,
      }),
    ).toEqual(historical);
    expect(sanitizeDiagnosticIdentity(null)).toBeUndefined();
    expect(sanitizeDiagnosticIdentity(undefined)).toBeUndefined();
  });

  it.each([
    { software_version: "https://private.invalid/?token=secret" },
    { software_version: "1.0.0-" + "a".repeat(64) },
    { software_version: "1.0.0\nprivate" },
    { runtime_scope: { toString: (): string => "PACKAGED_APP" } },
    { runtime_scope: "OTHER" },
    { expected_model_sha256: "A".repeat(64) },
    { expected_model_sha256: "../../private/model" },
    { package_inventory_sha256: "private-token" },
  ])("rejects malformed or private identity scalars: %j", (change) => {
    expect(
      sanitizeDiagnosticIdentity({
        ...resolveDiagnosticIdentity({}),
        ...change,
      }),
    ).toBeUndefined();
  });

  it.each([
    { schema_version: 2 },
    { architecture: "x64" },
    { includes_model_weights: true },
    { includes_worker_state: true },
    { files: [] },
    { files: Array.from({ length: 50_001 }, () => null) },
  ])("ignores an inventory with invalid audit markers", (change) => {
    const { resources, path } = fixture();
    writeFileSync(path, JSON.stringify({ ...inventory, ...change }));
    expect(
      resolveDiagnosticIdentity({ app_resources: resources }),
    ).not.toHaveProperty("package_inventory_sha256");
  });

  it("accepts at most 8 MiB and declines oversized files before opening them", () => {
    const { resources, path } = fixture();
    const maximum = 8 * 1024 * 1024;
    const content = JSON.stringify(inventory).padEnd(maximum, " ");
    writeFileSync(path, content);
    expect(
      resolveDiagnosticIdentity({ app_resources: resources })
        .package_inventory_sha256,
    ).toBe(createHash("sha256").update(content).digest("hex"));
    vi.mocked(fs.openSync).mockClear();
    appendFileSync(path, " ");
    expect(
      resolveDiagnosticIdentity({ app_resources: resources }),
    ).not.toHaveProperty("package_inventory_sha256");
    expect(fs.openSync).not.toHaveBeenCalled();
  });

  it.each([
    "missing",
    "malformed",
    "symlink",
    "hardlink",
    "directory",
    "group-write",
    "world-write",
    "unsafe-directory",
    "symlink-directory",
  ])("ignores %s inventory without failing the packaged recorder", (kind) => {
    const { resources, path } = fixture();
    let appResources = resources;
    if (kind === "missing") rmSync(path);
    if (kind === "malformed") writeFileSync(path, "not JSON private-path");
    if (kind === "symlink") {
      const target = join(resources, "target.json");
      writeFileSync(target, JSON.stringify(inventory));
      rmSync(path);
      symlinkSync(target, path);
    }
    if (kind === "hardlink") linkSync(path, join(resources, "linked.json"));
    if (kind === "directory") {
      rmSync(path);
      mkdirSync(path);
    }
    if (kind === "group-write") chmodSync(path, 0o664);
    if (kind === "world-write") chmodSync(path, 0o646);
    if (kind === "unsafe-directory") chmodSync(resources, 0o777);
    if (kind === "symlink-directory") {
      appResources = join(resources, "alias");
      symlinkSync(resources, appResources);
    }
    expect(resolveDiagnosticIdentity({ app_resources: appResources })).toEqual({
      software_version: VERSION,
      runtime_scope: "PACKAGED_APP",
      expected_model_sha256: MODEL_SHA256,
    });
    if (kind === "malformed") expect(fs.openSync).toHaveBeenCalledTimes(1);
    else expect(fs.openSync).not.toHaveBeenCalled();
  });

  it("bounds reads and omits evidence if the inventory grows while being read", async () => {
    const { resources, path } = fixture();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let changed = false;
    vi.mocked(readSync).mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number,
    ) => {
      const count = actual.readSync(fd, buffer, offset, length, position);
      if (!changed) {
        changed = true;
        appendFileSync(path, "private tail");
      }
      return count;
    }) as typeof readSync);
    expect(
      resolveDiagnosticIdentity({ app_resources: resources }),
    ).not.toHaveProperty("package_inventory_sha256");
    expect(fs.readSync).toHaveBeenCalledTimes(2);
    expect((vi.mocked(fs.readSync).mock.calls[0] as unknown[])[3]).toBe(
      Buffer.byteLength(JSON.stringify(inventory)) + 1,
    );
  });

  it("fingerprints an immutable app installed by a different Mac account", () => {
    const { resources } = fixture();
    vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    expect(
      resolveDiagnosticIdentity({ app_resources: resources })
        .package_inventory_sha256,
    ).toBe(
      createHash("sha256").update(JSON.stringify(inventory)).digest("hex"),
    );
  });

  it("declines inventory ownership that changes between metadata and descriptor reads", async () => {
    const { resources, path } = fixture();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const directory = actual.lstatSync(resources);
    const info = actual.lstatSync(path);
    const foreign = Object.assign(
      Object.create(Object.getPrototypeOf(info)),
      info,
      { uid: info.uid + 1 },
    ) as typeof info;
    vi.mocked(fs.lstatSync)
      .mockReturnValueOnce(directory)
      .mockReturnValueOnce(foreign);
    expect(
      resolveDiagnosticIdentity({ app_resources: resources }),
    ).not.toHaveProperty("package_inventory_sha256");
    expect(fs.openSync).toHaveBeenCalledTimes(1);
  });

  it("reuses the process identity without rereading inventory for additional recorders or reports", () => {
    const { resources, path } = fixture();
    const identity = resolveDiagnosticIdentity({ app_resources: resources });
    writeFileSync(
      path,
      JSON.stringify({
        ...inventory,
        files: [{ path: "changed-while-running" }],
      }),
    );
    const main = new Diagnostics(join(resources, "logs"), { identity });
    const setup = new Diagnostics(join(resources, "setup-logs"), { identity });
    try {
      for (const writer of [main, setup]) {
        writer.record({
          component: "companion",
          severity: "info",
          event: "companion_started",
        });
        expect(writer.snapshot().identity).toEqual(identity);
        expect(writer.snapshot().recent_events[0]?.identity).toEqual(identity);
      }
      expect(
        vi.mocked(fs.openSync).mock.calls.filter(([opened]) => opened === path),
      ).toHaveLength(1);
    } finally {
      main.close();
      setup.close();
    }
  });
});
