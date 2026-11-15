import { privateFileNativeFixture } from "./private-file-port-fixture.js";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createWindowsFleetAdvanced } from "../src/main/fleet/advanced/factory.js";
import {
  fleetRecordAuthority,
  VaultFleetStore,
} from "../src/main/fleet/store.js";
import { record, fleetSid, fleetNow } from "./fleet-fixtures.js";
import { receipt } from "./fixtures/prepare.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import type { HostContext } from "../src/main/host-context.js";
import type { FileCapabilities } from "../src/main/file-capabilities.js";
import type { ConsumerMutexScope } from "../../worker/src/platform/windows/consumer-native.js";
// Adapt only Windows absolute path spelling; actual qualification/dispatch validator still runs.
vi.mock("../../worker/src/enrollment/report-builder.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../worker/src/enrollment/report-builder.js")
  >("../../worker/src/enrollment/report-builder.js");
  return {
    ...actual,
    parseQualificationEvidence: (
      raw: unknown,
      options?: Parameters<typeof actual.parseQualificationEvidence>[1],
    ) => {
      const row = raw as { uploadCandidate: { path: string } },
        path = row.uploadCandidate.path;
      const value = actual.parseQualificationEvidence(
        {
          ...row,
          uploadCandidate: {
            ...row.uploadCandidate,
            path: path.startsWith("/")
              ? `C:${path.replaceAll("/", "\\")}`
              : path,
          },
        },
        options,
      );
      return { ...value, uploadCandidate: { ...value.uploadCandidate, path } };
    },
  };
});
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.flatMap((x) => x.split("\\"))),
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-fleet-purge-"));
  roots.push(root);
  const personal = join(root, "personal"),
    fleet = join(root, "fleet"),
    r = record(),
    output = Buffer.alloc(10000, 1),
    approved = Buffer.alloc(88, 2),
    hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex"),
    reportRelative = `prepare\\approved\\qualification-${createHash("sha256").update(r.requests.report).digest("hex")}.json`,
    outRelative = `prepare\\work\\${randomUUID()}\\engine\\qualified.mp3`,
    path = (namespace: string, relative: string) =>
      join(namespace === "fleet" ? fleet : personal, ...relative.split("\\")),
    save = async (
      namespace: string,
      relative: string,
      bytes: Buffer | string,
    ) => {
      const filename = path(namespace, relative);
      await mkdir(join(filename, ".."), { recursive: true, mode: 0o700 });
      await writeFile(filename, bytes);
    };
  r.prepared.modelDigest = MODEL.sha256;
  r.prepared.report.runtime.modelDigest = MODEL.sha256;
  r.prepared.fixtureDigest = hash(approved);
  r.prepared.qualificationPath = path("personal", reportRelative);
  r.prepared.output = {
    path: path("personal", outRelative),
    bytes: output.length,
    sha256: hash(output),
  };
  const raw = receipt().qualification;
  raw.serviceIdentity = fleetSid;
  raw.gpuIdentity = r.prepared.gpu;
  raw.gpuId = `dxgi-${r.prepared.gpu.luid}`;
  raw.directmlDeviceId = r.prepared.gpu.deviceIndex;
  raw.resourceObservations = {
    inferenceSlots: 1,
    dedicatedVideoMemoryLimitBytes: r.prepared.gpu.dedicatedVideoMemoryBytes,
    sharedSystemMemoryLimitBytes: r.prepared.gpu.sharedSystemMemoryLimitBytes,
  };
  raw.fixtureDigest = r.prepared.fixtureDigest;
  raw.recipes[0]!.resultDigest = hash(output);
  raw.recipes[0]!.resultBytes = output.length;
  raw.uploadCandidate = {
    ...raw.uploadCandidate,
    path: r.prepared.output.path,
    resultDigest: hash(output),
    resultBytes: output.length,
  };
  await save("personal", reportRelative, JSON.stringify(raw));
  await save("personal", outRelative, output);
  await save(
    "personal",
    `prepare\\approved\\${r.prepared.fixtureDigest}.wav`,
    approved,
  );
  await save("personal", `models\\${MODEL.filename}`, "preserve shared model");
  await save(
    "personal",
    "runtime\\releases\\retained.txt",
    "preserve shared runtime",
  );
  await save(
    "personal",
    "personal\\results\\guest.txt",
    "preserve local Library",
  );
  for (const rel of [
    "work\\old\\input.mp3",
    "logs\\events.jsonl",
    "state\\runtime.json",
    "reports\\old.json",
    "consumer-config.json",
  ])
    await save("fleet", rel, "fleet-owned bytes");
  const original = join(root, "selected-original.wav");
  await writeFile(original, "original user source");
  const authority = fleetRecordAuthority(r);
  r.phase = "revoked";
  r.retiredAuthority = authority;
  r.machineCredential = null;
  r.enrollmentCredential = null;
  r.installationCredential = null;
  const vault = new Map<string, Buffer>([
      ["fleet:enrollment", Buffer.from(JSON.stringify(r))],
      [
        "fleet:removed",
        Buffer.from(
          JSON.stringify({
            version: 1,
            machineId: r.machineId,
            authority,
            removedAt: new Date(fleetNow).toISOString(),
          }),
        ),
      ],
      [
        "fleet:confirmed_unpair",
        Buffer.from(
          JSON.stringify({
            version: 1,
            machineId: r.machineId,
            authority,
            revision: 3,
            confirmedAt: new Date(fleetNow).toISOString(),
          }),
        ),
      ],
      ["fleet:session_state", Buffer.from("shared session")],
      ["fleet:agent_bootstrap", Buffer.from("shared bootstrap")],
      ["account:credential", Buffer.from("protected app account")],
    ]),
    identity = {
      sid: fleetSid,
      sessionId: 1,
      pid: 12345,
      creationTime: "133000000000000000",
    };
  const native = {
    ...privateFileNativeFixture((relative) => path("personal", relative)),
    vaultRead: vi.fn(async (ns: string, key: string) =>
      vault.has(`${ns}:${key}`)
        ? Buffer.from(vault.get(`${ns}:${key}`)!)
        : null,
    ),
    vaultWrite: vi.fn(async (ns: string, key: string, bytes: Buffer) => {
      vault.set(`${ns}:${key}`, Buffer.from(bytes));
    }),
    vaultDelete: vi.fn(async (ns: string, key: string) => {
      vault.delete(`${ns}:${key}`);
    }),
    acquireMutex: vi.fn(async (scope: ConsumerMutexScope) => ({
      scope,
      nonce: "f".repeat(64),
      identity,
      abandoned: false,
    })),
    releaseMutex: vi.fn(async () => {}),
    ensurePrivateDirectory: vi.fn(async () => fleet),
    validatePath: vi.fn(async (ns: string, rel: string, kind: string) => {
      const s = await lstat(path(ns, rel));
      if (
        s.isSymbolicLink() ||
        (kind === "file" && (!s.isFile() || s.nlink !== 1))
      )
        throw new Error("ACL_UNSAFE");
    }),
  };
  const host = {
      native,
      identity,
      personalRoot: personal,
    } as unknown as HostContext,
    session = {
      command: vi.fn(async (command: { transaction?: string }) => ({
        maintenance: command.transaction
          ? { transaction: command.transaction, phase: "idle" }
          : null,
      })),
    },
    app = await createWindowsFleetAdvanced({
      host,
      native: { isOwnedProcess: async () => false },
      operations: {
        snapshotReadyStatus: async () => {
          throw new Error("MODEL_UNPREPARED");
        },
        snapshotReady: async () => {
          throw new Error("MODEL_UNPREPARED");
        },
      },
      session: session as never,
      files: {} as FileCapabilities,
      fileOwner: "window",
      storage: {} as never,
      exportArchive: async () => {},
      now: () => fleetNow,
    });
  return {
    root,
    personal,
    fleet,
    r,
    authority,
    vault,
    native,
    app,
    original,
    path,
    outRelative,
    reportRelative,
  };
}
async function confirmPurge(f: Awaited<ReturnType<typeof fixture>>) {
  await f.app.controller.execute({
    type: "CONFIRM",
    mutation: { action: "purge" },
  });
  return f.app.controller.snapshot().confirmation!.token;
}
it("full fleet purge removes private config/history/qualification and credentials while shared app/personal/session data stays intact", async () => {
  const f = await fixture(),
    token = await confirmPurge(f);
  await f.app.controller.execute({ type: "RUN", confirmation: token });
  expect(f.app.controller.snapshot()).toMatchObject({
    phase: "complete",
    data: { purged: "consumer-fleet-data" },
  });
  expect(f.vault.has("fleet:enrollment")).toBe(false);
  expect(
    JSON.parse(f.vault.get("fleet:purged_tombstone")!.toString()),
  ).toMatchObject({ authority: f.authority, machineId: f.r.machineId });
  for (const rel of [
    "consumer-config.json",
    "logs\\events.jsonl",
    "state\\runtime.json",
  ])
    await expect(lstat(f.path("fleet", rel))).rejects.toMatchObject({
      code: "ENOENT",
    });
  await expect(lstat(f.path("personal", f.outRelative))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    lstat(f.path("personal", f.reportRelative)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.vault.get("account:credential")!.toString()).toBe(
    "protected app account",
  );
  expect(f.vault.get("fleet:session_state")!.toString()).toBe("shared session");
  expect(f.vault.get("fleet:agent_bootstrap")!.toString()).toBe(
    "shared bootstrap",
  );
  expect(
    await readFile(f.path("personal", `models\\${MODEL.filename}`), "utf8"),
  ).toBe("preserve shared model");
  expect(await readFile(f.original, "utf8")).toBe("original user source");
  await f.app.controller.execute({ type: "READ", section: "status" });
  expect(f.app.controller.snapshot().data).toMatchObject({
    purged: true,
    identityRetired: true,
    explicitEnrollmentRequired: true,
  });
  await f.app.close();
});
it("lost enrollment-delete ACK recovers from minimal tombstone without credentials or repeat private file deletion", async () => {
  const f = await fixture(),
    deleteValue = f.native.vaultDelete.getMockImplementation()!;
  let failed = false;
  f.native.vaultDelete.mockImplementation(async (ns, key) => {
    if (key === "enrollment" && !failed) {
      failed = true;
      throw new Error("DPAPI_ACK_LOST");
    }
    await deleteValue(ns, key);
  });
  const token = await confirmPurge(f);
  await expect(
    f.app.controller.execute({ type: "RUN", confirmation: token }),
  ).rejects.toThrow("DPAPI_ACK_LOST");
  expect(f.vault.has("fleet:purged_tombstone")).toBe(true);
  await f.app.controller.execute({ type: "RECOVER" });
  expect(f.app.controller.snapshot().phase).toBe("complete");
  expect(f.vault.has("fleet:enrollment")).toBe(false);
  expect(f.vault.has("fleet:removed")).toBe(false);
  await f.app.close();
});
it("a replacement enrollment retires the old purge marker and prevents its interrupted journal from deleting new credentials", async () => {
  const f = await fixture(),
    originalDelete = f.native.vaultDelete.getMockImplementation()!;
  // Fail only after the tombstone commits, rather than during an earlier scratch cleanup.
  f.native.vaultDelete.mockImplementation(async (ns, key) => {
    if (key === "enrollment") throw new Error("DPAPI_ACK_LOST");
    await originalDelete(ns, key);
  });
  const token = await confirmPurge(f);
  await expect(
    f.app.controller.execute({ type: "RUN", confirmation: token }),
  ).rejects.toThrow("DPAPI_ACK_LOST");
  expect(f.vault.has("fleet:purged_tombstone")).toBe(true);
  f.native.vaultDelete.mockImplementation(originalDelete);
  const replacement = record();
  replacement.machineId = randomUUID();
  await new VaultFleetStore(f.native, fleetSid).write(replacement);
  expect(f.vault.has("fleet:purged_tombstone")).toBe(false);
  await expect(f.app.controller.execute({ type: "RECOVER" })).rejects.toThrow(
    "ADVANCED_MACHINE_CHANGED",
  );
  expect(JSON.parse(f.vault.get("fleet:enrollment")!.toString())).toEqual(
    replacement,
  );
  await f.app.close();
});
it("foreign/abandoned Prepare authority and selected-source scope mismatch refuse purge", async () => {
  for (const mode of ["abandoned", "source"]) {
    const f = await fixture();
    if (mode === "abandoned")
      f.native.acquireMutex.mockImplementation(async (scope) => ({
        scope,
        nonce: "f".repeat(64),
        identity: {
          sid: fleetSid,
          sessionId: 1,
          pid: 12345,
          creationTime: "133000000000000000",
        },
        abandoned: scope === "prepare",
      }));
    else {
      f.r.prepared.output.path = f.original;
      f.vault.set("fleet:enrollment", Buffer.from(JSON.stringify(f.r)));
    }
    const token = await confirmPurge(f);
    await expect(
      f.app.controller.execute({ type: "RUN", confirmation: token }),
    ).rejects.toThrow(
      mode === "abandoned"
        ? "ADVANCED_PURGE_RECOVERY_REQUIRED"
        : "ADVANCED_PURGE_SCOPE_INVALID",
    );
    expect(f.vault.has("fleet:enrollment")).toBe(true);
    expect(await readFile(f.original, "utf8")).toBe("original user source");
    await expect(
      lstat(f.path("fleet", "consumer-config.json")),
    ).resolves.toBeDefined();
  }
});
