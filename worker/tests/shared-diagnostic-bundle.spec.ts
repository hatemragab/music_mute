import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDiagnosticContents } from "../src/platform/shared/diagnostic-bundle.js";
import { validateWindowsDiagnosticDestination } from "../src/platform/windows/diagnostic-bundle.js";
import { createWindowsServiceLayout } from "../src/platform/windows/service-definition.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("shared diagnostic exports", () => {
  it("exports Windows lifecycle and readiness without credentials, config values or private paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-export-"));
    roots.push(root);
    await chmod(root, 0o700);
    const layout = {
      workRoot: join(root, "attempts"),
      configPath: join(root, "runtime.json"),
      runtimeStatusPath: join(root, "runtime-status.json"),
    };
    const staging = join(root, "staging");
    await mkdir(staging, { mode: 0o700 });
    await writeFile(
      layout.configPath,
      JSON.stringify({
        backendBaseUrl: "http://secret.invalid",
        credentialFile: "C:\\secret.credential",
        slots: [{ workerId: "private-id" }],
      }),
      { mode: 0o600 },
    );
    const assertConfigPrivate = vi.fn(async () => undefined);
    const result = await writeDiagnosticContents(staging, {
      layout,
      assertConfigPrivate,
      health: {
        schemaVersion: 1,
        healthy: false,
        checks: [
          { name: "credential", ok: false, path: "C:\\secret.credential" },
        ],
      },
      status: {
        status: "stopped",
        lifecycle: { intent: "draining" },
        readiness: {
          phase: "stopped",
          modelReady: false,
          blockers: ["service-stopped"],
        },
        credential: "secret-token",
      },
    });
    expect(assertConfigPrivate).toHaveBeenCalledWith(layout.configPath);
    expect(result.files).toHaveLength(6);
    const content = (
      await Promise.all(
        result.files.map((file) => readFile(join(staging, file), "utf8")),
      )
    ).join("\n");
    for (const secret of [
      "secret.invalid",
      "secret.credential",
      "secret-token",
      "private-id",
    ])
      expect(content).not.toContain(secret);
    expect(
      JSON.parse(await readFile(join(staging, "status.json"), "utf8")),
    ).toMatchObject({
      installed: true,
      lifecycle: "draining",
      service: { loaded: true, running: false },
      readiness: { claimEligible: null },
    });
  });
  it("records unavailable configuration without copying filesystem error text", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-unavailable-export-"));
    roots.push(root);
    await chmod(root, 0o700);
    const layout = {
      workRoot: join(root, "attempts"),
      configPath: join(root, "missing.json"),
      runtimeStatusPath: join(root, "runtime-status.json"),
    };
    const staging = join(root, "staging");
    await mkdir(staging, { mode: 0o700 });
    await writeDiagnosticContents(staging, {
      layout,
      status: {},
      health: { schemaVersion: 1, healthy: false, checks: [] },
      assertConfigPrivate: async () => {
        throw new Error("private-value");
      },
    });
    const manifest = JSON.parse(
      await readFile(join(staging, "manifest.json"), "utf8"),
    );
    expect(manifest.missingSections).toContain("configuration-field-names");
    const config = await readFile(join(staging, "config-fields.json"), "utf8");
    expect(JSON.parse(config)).toMatchObject({
      available: false,
      code: "CONFIG_FIELDS_UNAVAILABLE",
    });
    expect(config).not.toContain("private-value");
  });

  it("restricts Windows archive destinations and protects installed files", () => {
    const layout = createWindowsServiceLayout();
    for (const output of [
      "relative.zip",
      "\\\\server\\share\\report.zip",
      "C:\\reports\\..\\report.zip",
      "C:\\reports\\report.zip:stream",
      "C:\\reports\\CON.zip",
      "C:\\reports\\report.txt",
      layout.configPath,
      "C:\\ProgramData\\MusicMuteWorker\\releases\\report.zip",
    ])
      expect(() =>
        validateWindowsDiagnosticDestination(layout, output),
      ).toThrow();
    expect(() =>
      validateWindowsDiagnosticDestination(layout, "C:\\reports\\doctor.zip"),
    ).not.toThrow();
    expect(() =>
      validateWindowsDiagnosticDestination(
        layout,
        "C:\\ProgramData\\MusicMuteWorker\\service\\diagnostics-13827ae4-ad9d-4f23-8c6d-97b8d7157273.zip",
      ),
    ).not.toThrow();
  });
});
