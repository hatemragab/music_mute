import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import {
  createFleetAdvancedBusiness,
  createWindowsFleetAdvanced,
} from "../src/main/fleet/advanced/factory.js";
import type { StoreFleetAdvancedRuntime } from "../src/main/fleet/advanced/store-runtime.js";
import { FileCapabilities } from "../src/main/file-capabilities.js";
import type { HostContext } from "../src/main/host-context.js";
import type { AdvancedExportEntry } from "../src/main/fleet/advanced/benchmark-exports.js";
import { record, fleetSid, fleetNow } from "./fleet-fixtures.js";
import { privateFileNativeFixture } from "./private-file-port-fixture.js";
import {
  consumerRepeatedStored,
  processIdentity,
  readySnapshot,
} from "./fleet-advanced-fixtures.js";
// Store's private runtime boundary is synthetic here; the separate actual
// runtime strategy tests cover code/owner/cleanup receiving. This composition
// test executes the shared staging/journal/export flow and both writer routes.
const storeBoundary = vi.hoisted(() => {
  class Runtime {
    #host: unknown;
    #events: string[];
    #ready: () => unknown;
    constructor(host: unknown, events: string[], ready: () => unknown) {
      this.#host = host;
      this.#events = events;
      this.#ready = ready;
    }
    assertHost(host: unknown) {
      if (host !== this.#host) throw Error("FOREIGN_STORE_HOST");
    }
    async ready() {
      return this.#ready();
    }
    maintenancePort() {
      return {
        acquire: async () => ({
          release: async () => {
            this.#events.push("store-maintenance-end");
          },
        }),
        cancel: async () => {},
      };
    }
    stageBenchmark() {
      this.#events.push("store-stage");
    }
    async runBenchmark() {
      throw Error("SYNTHETIC_BOUNDARY_NOT_CONFIGURED");
    }
    async recoverBenchmark() {}
    async assertAvailable() {}
    mutationActive() {
      return false;
    }
  }
  return { Runtime };
});
vi.mock("../src/main/fleet/advanced/store-runtime.js", () => ({
  StoreFleetAdvancedRuntime: storeBoundary.Runtime,
}));
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.flatMap((p) => p.split("\\"))),
    },
  };
});

it.each(["legacy", "store"] as const)(
  "%s factory claims benchmark destinations before maintenance and streams verified artifacts while pins and borrowed handles remain held",
  async (distribution) => {
    const root = await mkdtemp(
      join(tmpdir(), "musicmute-advanced-composition-"),
    );
    let app: Awaited<ReturnType<typeof createWindowsFleetAdvanced>> | undefined;
    try {
      const personal = join(root, "personal"),
        fleet = join(root, "fleet"),
        events: string[] = [],
        files = new FileCapabilities(),
        enrollment = record(),
        vault = new Map<string, Buffer>([
          ["enrollment", Buffer.from(JSON.stringify(enrollment))],
        ]),
        path = (ns: string, relative: string) =>
          join(ns === "fleet" ? fleet : personal, ...relative.split("\\"));
      await mkdir(personal, { mode: 0o700 });
      await mkdir(fleet, { mode: 0o700 });
      const baselinePath = join(root, "baseline.json"),
        sourcePath = join(root, "source.wav"),
        baseline = Buffer.from(JSON.stringify(consumerRepeatedStored())),
        source = Buffer.from("fixture selected source"),
        audio = Buffer.from("fixture saved vocals");
      await writeFile(baselinePath, baseline);
      await writeFile(sourcePath, source);
      const baselineInput = await files.grant(baselinePath, "window"),
        input = await files.grant(sourcePath, "window"),
        native = {
          ...privateFileNativeFixture((relative) => path("personal", relative)),
          bootIdentity: async () => "e".repeat(64),
          vaultRead: async (_ns: string, key: string) =>
            vault.has(key) ? Buffer.from(vault.get(key)!) : null,
          vaultWrite: async (_ns: string, key: string, bytes: Buffer) => {
            vault.set(key, Buffer.from(bytes));
          },
          vaultDelete: async (_ns: string, key: string) => {
            vault.delete(key);
          },
          acquireMutex: async (scope: string) => ({
            scope,
            nonce: "f".repeat(64),
            identity: processIdentity,
            abandoned: false,
          }),
          releaseMutex: async () => {},
          processIdentity: async (pid: number) =>
            pid === process.pid ? { ...processIdentity, pid } : null,
          ensurePrivateDirectory: async () => fleet,
          validatePath: async (ns: string, rel: string, kind: string) => {
            if (kind === "absent") {
              await expect(lstat(path(ns, rel))).rejects.toMatchObject({
                code: "ENOENT",
              });
              return;
            }
            const s = await lstat(path(ns, rel));
            if (
              s.isSymbolicLink() ||
              (kind === "file"
                ? !s.isFile() || s.nlink !== 1
                : !s.isDirectory())
            )
              throw new Error("ACL_UNSAFE");
          },
        },
        host = {
          native,
          identity: processIdentity,
          personalRoot: personal,
          directory: async (relative: string) => {
            await mkdir(path("personal", relative), {
              recursive: true,
              mode: 0o700,
            });
          },
        } as unknown as HostContext;
      const borrowed: AdvancedExportEntry[] = [],
        writes: Record<string, Buffer[]> = {};
      const claim = vi.fn(
        async (_capability: string, kind: "audio" | "report") => {
          events.push(`claim:${kind}`);
          return {
            write: async (entries: readonly AdvancedExportEntry[]) => {
              events.push(`write:${kind}`);
              borrowed.push(...entries);
              writes[kind] = [];
              expect(events).not.toContain("pin-release");
              expect(events).not.toContain(`release:${kind}`);
              for (const entry of entries) {
                const bytes = Buffer.alloc(entry.bytes);
                await entry.file.read(bytes, 0, bytes.length, 0);
                expect(createHash("sha256").update(bytes).digest("hex")).toBe(
                  entry.sha256,
                );
                writes[kind]!.push(bytes);
              }
            },
            release: async () => {
              events.push(`release:${kind}`);
            },
          };
        },
      );
      const shared = {
        host,
        session: {
          command: async (c: { action: string; transaction?: string }) => {
            events.push(`session:${c.action}`);
            return {
              maintenance: c.transaction
                ? { transaction: c.transaction, phase: "idle" }
                : null,
            };
          },
        } as never,
        files,
        fileOwner: "window",
        now: () => fleetNow,
        storage: {
          protectTree: async () => ({
            release: async () => {
              events.push("pin-release");
            },
          }),
          beginWrite: async () => ({
            captureCreated: async () => {
              events.push("birth");
            },
            settle: async () => {},
            handoff: async () => {
              events.push("writer-handoff");
            },
          }),
          trackWorkspace: async () => ({ release: async () => {} }),
        },
        exportArchive: async () => {},
        benchmarkExports: { claim },
      };
      app =
        distribution === "legacy"
          ? await createWindowsFleetAdvanced({
              ...shared,
              native: { isOwnedProcess: async () => false },
              operations: {
                snapshotReady: async () => readySnapshot(),
                snapshotReadyStatus: async () => readySnapshot(),
              },
            })
          : await createFleetAdvancedBusiness({
              ...shared,
              storeRuntime: new storeBoundary.Runtime(host, events, () => ({
                ...readySnapshot(),
                distribution: "microsoft-store",
                archiveSha256: null,
              })) as unknown as StoreFleetAdvancedRuntime,
            });
      // Only the real hardware/native benchmark boundary is injected. Production staging,
      // baseline parsing, CAS journal, descriptor hashing, exports and teardown all execute.
      const benchmark = app.benchmark;
      vi.spyOn(benchmark, "run").mockImplementation(
        async (_transaction, args) => {
          if (distribution === "store")
            expect(events).toContain("writer-handoff");
          else expect(events).not.toContain("writer-handoff"); // legacy mock skips the real runner's beforeLaunch
          expect(args).toMatchObject({
            groupSize: 1,
            saveAudio: true,
            operation: "benchmark_file",
          });
          expect(
            await readFile(path("personal", args.fixture.relativePath)),
          ).toEqual(source);
          const name = "01-cold-vocals.mp3",
            dir = `prepare\\work\\${args.requestId}\\saved-audio`;
          await host.directory(dir);
          await writeFile(path("personal", `${dir}\\${name}`), audio);
          events.push("benchmark-return");
          const report = {
            ...consumerRepeatedStored(),
            savedAudio: true,
            savedAudioArtifacts: [
              {
                iteration: 1,
                role: "cold" as const,
                format: "mp3" as const,
                fileName: name,
                bytes: audio.length,
                sha256: createHash("sha256").update(audio).digest("hex"),
              },
            ],
          };
          return { report } as Awaited<ReturnType<typeof benchmark.run>>;
        },
      );
      await app.controller.execute({
        type: "CONFIRM",
        mutation: {
          action: "benchmark_file",
          inputCapability: input.capability,
          baselineCapability: baselineInput.capability,
          recipe: "kim-vocals-v2",
          warmupRuns: 1,
          measuredRuns: 3,
          rightsConfirmed: true,
          groupSize: 1,
          saveAudio: true,
          audioDestinationCapability: randomUUID(),
          reportDestinationCapability: randomUUID(),
        },
      });
      expect(events).toEqual(["claim:audio", "claim:report"]);
      await app.controller.execute({
        type: "RUN",
        confirmation: app.controller.snapshot().confirmation!.token,
      });
      expect(writes.audio).toEqual([audio]);
      expect(JSON.parse(writes.report![0]!.toString())).toMatchObject({
        comparison: { comparable: true },
      });
      expect(app.controller.snapshot().data).toMatchObject({
        audioExported: true,
        reportExported: true,
        sourcePreserved: true,
      });
      expect(events.indexOf("write:audio")).toBeLessThan(
        events.indexOf("pin-release"),
      );
      expect(events.indexOf("pin-release")).toBeLessThan(
        events.indexOf("release:audio"),
      );
      for (const entry of borrowed)
        await expect(entry.file.stat()).rejects.toMatchObject({
          code: "EBADF",
        });
      expect(await readFile(sourcePath)).toEqual(source);
      expect(await readFile(baselinePath)).toEqual(baseline);
      expect(fleetSid).toBe(enrollment.sid);

      // This resource has not reached the controller when its second claim
      // fails. Its first destination must remain owned after cleanup rejects.
      const originalClaim = claim.getMockImplementation()!,
        claimFailure = Error("REPORT_DESTINATION_CLAIM_FAILED"),
        partialCloseFailure = Error("AUDIO_DESTINATION_CLOSE_UNKNOWN"),
        partialRelease = vi
          .fn<() => Promise<void>>()
          .mockRejectedValueOnce(partialCloseFailure)
          .mockResolvedValue(undefined),
        partialClaim = vi.fn(async (kind: "audio" | "report") => {
          if (kind === "report") throw claimFailure;
          return { write: async () => {}, release: partialRelease };
        });
      claim.mockImplementation((_capability, kind) => partialClaim(kind));
      await expect(
        app.controller.execute({
          type: "CONFIRM",
          mutation: {
            action: "benchmark_file",
            inputCapability: randomUUID(),
            recipe: "kim-vocals-v2",
            warmupRuns: 1,
            measuredRuns: 3,
            rightsConfirmed: true,
            saveAudio: true,
            audioDestinationCapability: randomUUID(),
            reportDestinationCapability: randomUUID(),
          },
        }),
      ).rejects.toMatchObject({
        message: "ADVANCED_CONFIRMATION_CLEANUP_PENDING",
        errors: [claimFailure, partialCloseFailure],
      });
      expect(partialRelease).toHaveBeenCalledOnce();
      await app.controller.execute({
        type: "CONFIRM",
        mutation: { action: "clear_logs" },
      });
      expect(partialRelease).toHaveBeenCalledTimes(2);
      expect(partialClaim.mock.calls.map(([kind]) => kind)).toEqual([
        "audio",
        "report",
      ]);
      await app.controller.execute({ type: "CANCEL" });

      // A withdrawn confirmation still owns a destination whose exact release
      // failed. Retirement retries that same destination, never already closed
      // siblings or an optimistic factory "released" flag.
      const unknown = Error("REPORT_DESTINATION_CLOSE_UNKNOWN"),
        destinationReleases = {
          audio: vi.fn(async () => {}),
          report: vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(unknown)
            .mockResolvedValue(undefined),
        };
      claim.mockImplementation(async (capability, kind) => ({
        ...(await originalClaim(capability, kind)),
        release: destinationReleases[kind],
      }));
      await app.controller.execute({
        type: "CONFIRM",
        mutation: {
          action: "benchmark_file",
          inputCapability: randomUUID(),
          recipe: "kim-vocals-v2",
          warmupRuns: 1,
          measuredRuns: 3,
          rightsConfirmed: true,
          saveAudio: true,
          audioDestinationCapability: randomUUID(),
          reportDestinationCapability: randomUUID(),
        },
      });
      await expect(app.controller.execute({ type: "CANCEL" })).rejects.toBe(
        unknown,
      );
      await app.controller.beginRetirement();
      expect(destinationReleases.audio).toHaveBeenCalledOnce();
      expect(destinationReleases.report).toHaveBeenCalledTimes(2);
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
