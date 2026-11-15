import { privateFileNativeFixture } from "./private-file-port-fixture.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createWindowsFleetAdvanced } from "../src/main/fleet/advanced/factory.js";
import {
  consumerCapacityIdentity,
  createConsumerFleetCapacityReceipt,
} from "../src/main/fleet/advanced/capacity.js";
import { fleetRecordAuthority } from "../src/main/fleet/store.js";
import { parseCapacityBenchmarkReport } from "../../worker/src/platform/shared/capacity-benchmark.js";
import type { HostContext } from "../src/main/host-context.js";
import type { ConsumerHostIdentity } from "../../worker/src/platform/windows/consumer-native.js";
import { FileCapabilities } from "../src/main/file-capabilities.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { fleetNow, fleetSid, record } from "./fleet-fixtures.js";
import {
  advancedGpu,
  consumerCapacityRaw,
  processIdentity,
  readySnapshot,
} from "./fleet-advanced-fixtures.js";

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.flatMap((part) => part.split("\\"))),
    },
  };
});

it("validates a real hash-bound capacity report with status attestation while capacity mutation demands full current bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-advanced-status-"));
  let app: Awaited<ReturnType<typeof createWindowsFleetAdvanced>> | undefined;
  try {
    const personal = join(root, "personal"),
      fleet = join(root, "fleet");
    await mkdir(join(personal, "prepare", "results"), { recursive: true });
    await mkdir(fleet);
    const enrollment = record();
    enrollment.prepared.modelDigest = MODEL.sha256;
    enrollment.prepared.report.runtime.modelDigest = MODEL.sha256;
    enrollment.prepared.fixtureDigest = "c".repeat(64);
    const identity: ConsumerHostIdentity = {
      ...processIdentity,
      nativeArch: "x64",
      processArch: "x64",
      logonSid: "S-1-5-5-1-2",
      osMajor: 10,
      osBuild: 19045,
      localAppData: "C:\\Users\\fixture\\AppData\\Local",
    };
    const context = consumerCapacityIdentity({
      bootIdentity: "e".repeat(64),
      host: identity,
      gpu: advancedGpu,
      manifestDigest: enrollment.prepared.manifestDigest,
      modelDigest: MODEL.sha256,
      fixtureDigest: enrollment.prepared.fixtureDigest,
    });
    const receipt = Buffer.from(
      JSON.stringify(
        createConsumerFleetCapacityReceipt(
          enrollment,
          context,
          parseCapacityBenchmarkReport(consumerCapacityRaw(), {
            provider: "directml",
            expectedUserSid: fleetSid,
            fixtureDigest: enrollment.prepared.fixtureDigest,
            warmupRuns: 1,
            measuredRuns: 3,
          }),
          fleetNow,
        ),
      ),
    );
    const relative = `prepare\\results\\${randomUUID()}.capacity.json`;
    await writeFile(join(personal, ...relative.split("\\")), receipt);
    const vault = new Map<string, Buffer>([
      ["enrollment", Buffer.from(JSON.stringify(enrollment))],
      [
        "capacity",
        Buffer.from(
          JSON.stringify({
            version: 1,
            machineId: enrollment.machineId,
            authority: fleetRecordAuthority(enrollment),
            selectedWorkers: 2,
            secondWorkerId: randomUUID(),
            receipt: {
              relativePath: relative,
              sha256: createHash("sha256").update(receipt).digest("hex"),
            },
          }),
        ),
      ],
    ]);
    const native = {
      ...privateFileNativeFixture((relative) =>
        join(personal, ...relative.split("\\")),
      ),
      bootIdentity: async () => "e".repeat(64),
      enumerateGpus: async () => [advancedGpu],
      vaultRead: async (_namespace: string, key: string) =>
        vault.get(key) ?? null,
      vaultWrite: async (_namespace: string, key: string, bytes: Buffer) => {
        vault.set(key, Buffer.from(bytes));
      },
      acquireMutex: async (scope: string) => ({
        scope,
        nonce: "f".repeat(64),
        identity: processIdentity,
        abandoned: false,
      }),
      releaseMutex: async () => {},
      ensurePrivateDirectory: async () => fleet,
      validatePath: async (namespace: string, name: string, kind: string) => {
        const actual = await lstat(
          join(namespace === "fleet" ? fleet : personal, ...name.split("\\")),
        );
        if (
          actual.isSymbolicLink() ||
          (kind === "file" && (!actual.isFile() || actual.nlink !== 1))
        )
          throw new Error("FIXTURE_PATH_INVALID");
      },
    };
    const ready = {
      ...readySnapshot(),
      archiveSha256: enrollment.prepared.archiveDigest,
    };
    const operations = {
      snapshotReadyStatus: vi.fn(async () => ready),
      snapshotReady: vi.fn(async () => {
        throw new Error("FULL_CURRENT_BYTES_CHANGED");
      }),
    };
    const fetcher = vi.fn<typeof fetch>();
    app = await createWindowsFleetAdvanced({
      host: {
        native,
        identity,
        personalRoot: personal,
      } as unknown as HostContext,
      native: { isOwnedProcess: async () => false },
      operations,
      session: {
        command: async (command: { transaction?: string }) => ({
          fleet: { intent: "paused", phase: "paused", problem: null },
          maintenance: command.transaction
            ? { transaction: command.transaction, phase: "idle" }
            : null,
        }),
      } as never,
      files: new FileCapabilities(),
      fileOwner: "window",
      storage: {} as never,
      exportArchive: async () => {},
      fetch: fetcher,
      now: () => fleetNow,
    });
    await app.controller.execute({ type: "READ", section: "capacity" });
    expect(app.controller.snapshot().data).toMatchObject({
      validatedWorkers: 2,
      effectiveLocalWorkers: 2,
      problem: null,
      backendPermission: { current: false },
    });
    expect(operations.snapshotReadyStatus).toHaveBeenCalledTimes(1);
    expect(operations.snapshotReady).not.toHaveBeenCalled();
    await app.controller.execute({
      type: "CONFIRM",
      mutation: { action: "capacity", workers: 2 },
    });
    await expect(
      app.controller.execute({
        type: "RUN",
        confirmation: app.controller.snapshot().confirmation!.token,
      }),
    ).rejects.toThrow("FULL_CURRENT_BYTES_CHANGED");
    expect(operations.snapshotReady).toHaveBeenCalledTimes(1);
    expect(operations.snapshotReadyStatus).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(app.controller.snapshot().phase).toBe("recovery");
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
