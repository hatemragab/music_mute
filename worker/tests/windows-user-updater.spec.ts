import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  checkWindowsUserUpdate,
  updateWindowsUserWorker,
} from "../src/platform/windows/user-updater.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { buildServiceRuntimeConfig } from "../src/enrollment/runtime-config-builder.js";
import {
  windowsUpdatedConfig,
  assertWindowsUpdateRequestPath,
} from "../src/platform/windows/update-plan.js";
import { createWindowsServiceLayout } from "../src/platform/windows/service-definition.js";
import {
  canonicalUpdateMetadata,
  parseUpdateCandidate,
  verifyUpdateMetadata,
  type UpdateMetadata,
} from "../src/platform/shared/update-metadata.js";
import { runWindowsUserCommand } from "../src/platform/windows/user-cli.js";

function fixture() {
  const metadata: UpdateMetadata = {
    schemaVersion: 1,
    sequence: 7,
    platform: "windows-amd64",
    releaseVersion: "0.2.0",
    publishedAt: "2026-09-28T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
    release: {
      filename: "musicmute-windows-amd64.zip",
      contentType: "application/zip",
      bytes: 12345,
      sha256: "a".repeat(64),
    },
  };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeys = {
    test: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const signed = (value: UpdateMetadata) => ({
    keyId: "test",
    metadata: value,
    signature: sign(
      null,
      Buffer.from(canonicalUpdateMetadata(value)),
      privateKey,
    ).toString("base64url"),
  });
  const candidate = {
    signed: signed(metadata),
    grant: {
      url: "https://private.invalid/release.zip?secret=signed-grant",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
  const options = {
    layout: createWindowsServiceLayout(),
    service: {
      assertPrivateInstallation: vi.fn(async () => undefined),
      inspect: vi.fn(async () => ({
        state: "stopped" as const,
        processId: null,
        runtimeProcessId: null,
        runtimeStartedAt: null,
      })),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
    privateFile: vi.fn(async () => undefined),
    activeVersion: vi.fn(async () => "0.1.0"),
    connection: vi.fn(async () => ({
      machineId: "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
      backendBaseUrl: "https://backend.invalid",
      credential: "x".repeat(43),
      allowInsecureLoopback: false,
    })),
    state: vi.fn(async () => ({
      schemaVersion: 1 as const,
      highestSequence: 6,
      quarantinedVersions: [] as string[],
    })),
    trust: vi.fn(async () => publicKeys),
    candidate: vi.fn(async () => candidate),
    now: new Date("2026-09-29T00:00:00.000Z"),
  };
  return { metadata, signed, publicKeys, candidate, options };
}

describe("Windows signed update checks", () => {
  it("routes manual activation and refuses conflicting check/force flags", async () => {
    const f = fixture();
    const update = vi.fn(async () => ({
      status: "updated" as const,
      releaseVersion: "0.2.0",
      sequence: 7,
      capacityRequalificationRequired: true,
    }));
    const output: string[] = [];
    const context = {
      host: { platform: "win32" as const, arch: "x64" },
      layout: f.options.layout,
      service: f.options.service,
      update,
      stdout: (line: string) => output.push(line),
    };
    expect(
      await runWindowsUserCommand("update", ["--force", "--json"], context),
    ).toBe(0);
    expect(update).toHaveBeenCalledWith({
      layout: f.options.layout,
      service: f.options.service,
      force: true,
    });
    expect(JSON.parse(output[0]!)).toMatchObject({
      action: "update",
      status: "updated",
      sequence: 7,
    });
    await expect(
      runWindowsUserCommand("update", ["--force", "--check"], context),
    ).rejects.toThrow("Use update");
    expect(update).toHaveBeenCalledOnce();
  });
  it("prepares a new release with one stable slot while preserving pairing and the old config", () => {
    const layout = createWindowsServiceLayout();
    const config = buildServiceRuntimeConfig({
      platform: "windows-amd64",
      installRoot: layout.installRoot,
      releaseVersion: "0.1.0",
      backendBaseUrl: "https://api.example.invalid",
      machineId: "00000000-0000-4000-8000-000000000010",
      workerId: "00000000-0000-4000-8000-000000000011",
    });
    const previous = {
      ...config,
      validatedMaxWorkersPerGpu: 2,
      slots: [
        config.slots[0],
        {
          ...config.slots[0],
          workerId: "00000000-0000-4000-8000-000000000012",
          slotIndex: 1,
        },
      ],
      capacityValidationFile: win32.join(
        layout.stateRoot,
        "capacity-validation.json",
      ),
    };
    const updated = windowsUpdatedConfig(layout, previous, "0.2.0");
    expect(updated).toMatchObject({
      machineId: config.machineId,
      backendBaseUrl: config.backendBaseUrl,
      credentialFile: config.credentialFile,
      validatedMaxWorkersPerGpu: 1,
      slots: [config.slots[0]],
      inactiveSlots: [previous.slots[1]],
    });
    expect(updated.engineRoot).toBe(
      win32.join(layout.releasesRoot, "0.2.0", "app", "engine"),
    );
    expect(previous.slots).toHaveLength(2);
    expect(() =>
      windowsUpdatedConfig(
        layout,
        { ...previous, credentialFile: "C:\\foreign" },
        "0.2.0",
      ),
    ).toThrow();
    const request = win32.join(
      layout.serviceRoot,
      "update-12345678-1234-1234-1234-123456789abc",
      "request.json",
    );
    expect(assertWindowsUpdateRequestPath(layout, request)).toBe(
      win32.dirname(request),
    );
    for (const path of [
      win32.join(layout.stateRoot, "request.json"),
      request + "\\..\\request.json",
      "\\\\host\\share\\request.json",
    ])
      expect(() => assertWindowsUpdateRequestPath(layout, path)).toThrow();
  });

  it.each([false, true])(
    "commits the expected native release and sequence (cleanup failure=%s)",
    async (cleanupFails) => {
      const f = fixture();
      const root = await mkdtemp(join(tmpdir(), "mw-update-flow-"));
      try {
        const layout = { ...f.options.layout, serviceRoot: root };
        const checked = await checkWindowsUserUpdate(f.options);
        let active = "0.1.0",
          highest = 6;
        const downloadArtifact = vi.fn(
          async (args: { outputPath: string }) => ({
            path: args.outputPath,
            bytes: 12345,
            sha256: "a".repeat(64),
            reused: false,
          }),
        );
        const prepareRelease = vi.fn(async (args: { outputRoot: string }) => ({
          path: join(args.outputRoot, "release-0.2.0"),
          releaseVersion: "0.2.0",
          reused: false,
        }));
        const manager = vi.fn(async (_script: string, args: string[]) => {
          const request = JSON.parse(
            await readFile(args[args.indexOf("-UpdateRequest") + 1]!, "utf8"),
          );
          expect(request).toMatchObject({
            schemaVersion: 1,
            previousVersion: "0.1.0",
            force: true,
            configSha256: "b".repeat(64),
          });
          expect(JSON.stringify(request)).not.toContain("signed-grant");
          active = "0.2.0";
          highest = 7;
        });
        const result = await updateWindowsUserWorker({
          ...f.options,
          layout,
          force: true,
          check: async () => checked,
          pending: async () => false,
          digest: async () => "b".repeat(64),
          availableDiskBytes: async () => 1e12,
          writeRecord: async (path, value) => {
            await writeFile(path, JSON.stringify(value), {
              flag: "wx",
              mode: 0o600,
            });
          },
          downloadArtifact,
          prepareRelease,
          verifyRelease: async () => ({
            schemaVersion: 1,
            platform: "win32",
            architecture: "x64",
            releaseVersion: "0.2.0",
            entries: [],
          }),
          manager,
          ...(cleanupFails
            ? {
                removeTransaction: async () => {
                  throw new Error("private cleanup failure");
                },
              }
            : {}),
          activeVersion: async () => active,
          state: async () => ({
            schemaVersion: 1,
            highestSequence: highest,
            quarantinedVersions: [],
          }),
        });
        expect(result).toMatchObject({
          status: "updated",
          releaseVersion: "0.2.0",
          sequence: 7,
        });
        expect(downloadArtifact).toHaveBeenCalledWith(
          expect.objectContaining({
            expectedSha256: "a".repeat(64),
            expectedContentType: "application/zip",
          }),
        );
        expect(manager).toHaveBeenCalledOnce();
        if (cleanupFails) {
          expect(result.cleanupWarning).toBe(
            "Update scratch cleanup deferred; run mw cleanup --apply",
          );
          expect(await readdir(root)).toHaveLength(1);
        } else {
          expect(result.cleanupWarning).toBeUndefined();
          expect(await readdir(root)).toEqual([]);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("retains update scratch while recovery is pending", async () => {
    const f = fixture();
    const root = await mkdtemp(join(tmpdir(), "mw-update-pending-"));
    try {
      const checked = await checkWindowsUserUpdate(f.options);
      let pending = false;
      const removeTransaction = vi.fn(async () => {});
      await expect(
        updateWindowsUserWorker({
          ...f.options,
          layout: { ...f.options.layout, serviceRoot: root },
          check: async () => checked,
          pending: async () => pending,
          digest: async () => "b".repeat(64),
          availableDiskBytes: async () => 1e12,
          writeRecord: async (path, value) => {
            await writeFile(path, JSON.stringify(value), { flag: "wx" });
          },
          downloadArtifact: async () => {
            pending = true;
            throw new Error("interrupted update");
          },
          removeTransaction,
        }),
      ).rejects.toThrow("interrupted update");
      expect(removeTransaction).not.toHaveBeenCalled();
      expect(await readdir(root)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the update error if scratch cleanup also fails", async () => {
    const f = fixture();
    const root = await mkdtemp(join(tmpdir(), "mw-update-cleanup-failed-"));
    const warning = vi
      .spyOn(process, "emitWarning")
      .mockImplementation(() => {});
    try {
      const checked = await checkWindowsUserUpdate(f.options);
      await expect(
        updateWindowsUserWorker({
          ...f.options,
          layout: { ...f.options.layout, serviceRoot: root },
          check: async () => checked,
          pending: async () => false,
          digest: async () => "b".repeat(64),
          availableDiskBytes: async () => 0,
          removeTransaction: async () => {
            throw new Error("cleanup error");
          },
        }),
      ).rejects.toThrow("Insufficient disk space");
      expect(warning).toHaveBeenCalledWith(
        "Update scratch cleanup deferred; run mw cleanup --apply",
        { code: "WORKER_CLEANUP_DEFERRED" },
      );
      expect(await readdir(root)).toHaveLength(1);
    } finally {
      warning.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses pending recovery, low disk and archive failure before service mutation", async () => {
    const f = fixture();
    const root = await mkdtemp(join(tmpdir(), "mw-update-refusal-"));
    try {
      const checked = await checkWindowsUserUpdate(f.options);
      const manager = vi.fn();
      const check = vi.fn(async () => checked);
      const base = {
        ...f.options,
        layout: { ...f.options.layout, serviceRoot: root },
        check,
        manager,
        digest: async () => "b".repeat(64),
        writeRecord: async (path: string, value: unknown) => {
          await writeFile(path, JSON.stringify(value), { flag: "wx" });
        },
        pending: async () => false,
      };
      await expect(
        updateWindowsUserWorker({ ...base, pending: async () => true }),
      ).rejects.toThrow("Recover");
      expect(check).not.toHaveBeenCalled();
      await expect(
        updateWindowsUserWorker({ ...base, availableDiskBytes: async () => 0 }),
      ).rejects.toThrow("disk space");
      await expect(
        updateWindowsUserWorker({
          ...base,
          availableDiskBytes: async () => 1e12,
          downloadArtifact: async () => {
            throw new Error("checksum");
          },
        }),
      ).rejects.toThrow("checksum");
      expect(manager).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks Windows ZIP metadata without starting or stopping the service", async () => {
    const f = fixture();
    const result = await checkWindowsUserUpdate(f.options);
    expect(result).toMatchObject({
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      sequence: 7,
      updateAvailable: true,
      metadata: {
        platform: "windows-amd64",
        release: { contentType: "application/zip" },
      },
    });
    expect(f.options.service.start).not.toHaveBeenCalled();
    expect(f.options.service.stop).not.toHaveBeenCalled();
    expect(
      parseUpdateCandidate(
        { schemaVersion: 1, platform: "windows-amd64", ...f.candidate },
        "windows-amd64",
      ),
    ).toEqual(f.candidate);
  });
  it("refuses target substitution, wrong archive type and signed metadata tampering", () => {
    const f = fixture();
    const options = {
      platform: "windows-amd64" as const,
      publicKeys: f.publicKeys,
      minimumSequence: 0,
      now: f.options.now,
    };
    expect(() =>
      verifyUpdateMetadata(
        f.signed({
          ...f.metadata,
          platform: "darwin-arm64",
          release: { ...f.metadata.release, contentType: "application/gzip" },
        }),
        options,
      ),
    ).toThrow("metadata is invalid");
    expect(() =>
      verifyUpdateMetadata(
        f.signed({
          ...f.metadata,
          release: { ...f.metadata.release, contentType: "application/gzip" },
        }),
        options,
      ),
    ).toThrow("release metadata is invalid");
    expect(() =>
      verifyUpdateMetadata(
        {
          ...f.candidate.signed,
          metadata: { ...f.metadata, releaseVersion: "8.0.0" },
        },
        options,
      ),
    ).toThrow("signature does not match");
    for (const filename of ["release.tar.gz", "NUL.zip", "COM1.zip"])
      expect(() =>
        verifyUpdateMetadata(
          f.signed({
            ...f.metadata,
            release: { ...f.metadata.release, filename },
          }),
          options,
        ),
      ).toThrow("release metadata is invalid");
  });
  it("rejects expired, untrusted, quarantined and rolled-back candidates", async () => {
    const f = fixture();
    await expect(
      checkWindowsUserUpdate({
        ...f.options,
        now: new Date("2026-10-02T00:00:00Z"),
      }),
    ).rejects.toThrow("validity window");
    await expect(
      checkWindowsUserUpdate({ ...f.options, trust: async () => ({}) }),
    ).rejects.toThrow("not trusted");
    await expect(
      checkWindowsUserUpdate({
        ...f.options,
        state: async () => ({
          schemaVersion: 1,
          highestSequence: 8,
          quarantinedVersions: [],
        }),
      }),
    ).rejects.toThrow("rollback");
    await expect(
      checkWindowsUserUpdate({
        ...f.options,
        state: async () => ({
          schemaVersion: 1,
          highestSequence: 6,
          quarantinedVersions: ["0.2.0"],
        }),
      }),
    ).rejects.toThrow("quarantined");
  });
  it("does not report equal or older versions as updates", async () => {
    const f = fixture();
    for (const currentVersion of ["0.2.0", "0.3.0"])
      expect(
        (
          await checkWindowsUserUpdate({
            ...f.options,
            activeVersion: async () => currentVersion,
          })
        ).updateAvailable,
      ).toBe(false);
  });
  it("stops at failed installation trust before reading credentials or requesting metadata", async () => {
    const f = fixture();
    f.options.service.assertPrivateInstallation.mockRejectedValue(
      new Error("Unsafe ACL"),
    );
    await expect(checkWindowsUserUpdate(f.options)).rejects.toThrow(
      "Unsafe ACL",
    );
    expect(f.options.connection).not.toHaveBeenCalled();
    expect(f.options.candidate).not.toHaveBeenCalled();
  });
  it("prints an allowlisted CLI result without a signed download URL", async () => {
    const f = fixture();
    const checked = await checkWindowsUserUpdate(f.options);
    const output: string[] = [];
    expect(
      await runWindowsUserCommand("update", ["--check", "--json"], {
        host: { platform: "win32", arch: "x64" },
        layout: f.options.layout,
        service: f.options.service,
        checkUpdate: async () => checked,
        stdout: (value) => output.push(value),
      }),
    ).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual({
      action: "update-check",
      status: "ok",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      sequence: 7,
      updateAvailable: true,
    });
    expect(output.join()).not.toContain("private.invalid");
    expect(output.join()).not.toContain("signed-grant");
  });
});
