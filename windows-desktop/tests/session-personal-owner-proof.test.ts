import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchPersonalOwnerProof,
  parsePersonalOwnerProof,
  personalOwnerProofCommand,
} from "../src/main/session/personal-owner-proof.js";
import { createSessionDispatcher } from "../src/main/session/control.js";
import type { SessionSupervisor } from "../src/main/session/supervisor.js";
import type { PersonalAgentClient } from "../src/main/personal/session-port.js";
import type { PersonalJobView } from "../src/shared/personal-contracts.js";
const peer = {
    sid: "S-1-5-21-1-2-3-1001",
    sessionId: 1,
    pid: 50,
    creationTime: "133400000000000001",
  },
  authority = { ...peer, pid: 51 },
  request = {
    ownerId: randomUUID(),
    jobId: randomUUID(),
    videoId: "bZxrIoCPsOc",
    peer,
  };
function fixture() {
  const job: PersonalJobView = {
      id: request.jobId,
      ownerId: request.ownerId,
      state: "ready",
      stage: "output-validation",
      progress: 1,
      name: "Fixture",
      error: null,
      original: null,
      source: { kind: "youtube", videoId: request.videoId },
      vocals: {
        id: randomUUID(),
        kind: "vocals",
        name: "PrivateName.mp3",
        bytes: 256,
        sha256: "a".repeat(64),
        durationSeconds: 60,
        contentType: "audio/mpeg",
      },
    },
    verifyPersonalOwnerProofPeers = vi.fn(async () => true),
    authorizePersonalOwner = vi.fn(async () => {}),
    command = vi.fn(async () => ({
      version: 1 as const,
      requestId: randomUUID(),
      ok: true,
      jobs: [job],
    }));
  return {
    job,
    native: { verifyPersonalOwnerProofPeers },
    supervisor: { authorizePersonalOwner },
    personal: { command },
  };
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
describe("trusted account authority read-only personal playback proof", () => {
  it("requires existing peer ownership and source/ready bytes without attaching or running a job", async () => {
    const f = fixture(),
      body = personalOwnerProofCommand(request),
      reply = JSON.parse(
        (
          await dispatchPersonalOwnerProof(encode(body), authority, f)
        ).toString(),
      );
    expect(f.native.verifyPersonalOwnerProofPeers).toHaveBeenCalledWith(
      authority,
      peer,
      "chrome",
    );
    expect(f.supervisor.authorizePersonalOwner).toHaveBeenCalledWith(
      request.ownerId,
      peer,
      "chrome",
    );
    expect(f.personal.command).toHaveBeenCalledWith(
      expect.objectContaining({ action: "jobs", ownerId: request.ownerId }),
      peer,
      null,
    );
    expect(parsePersonalOwnerProof(reply.proof, request).vocals.sha256).toBe(
      "a".repeat(64),
    );
    expect(JSON.stringify(reply)).not.toMatch(
      /PrivateName|token|firebase_uid|C:\\/u,
    );
  });
  it("denies an unsigned or wrong-authority peer before querying any job", async () => {
    const f = fixture();
    f.native.verifyPersonalOwnerProofPeers.mockResolvedValue(false);
    await expect(
      dispatchPersonalOwnerProof(
        encode(personalOwnerProofCommand(request)),
        authority,
        f,
      ),
    ).rejects.toThrow("PEER_DENIED");
    expect(f.personal.command).not.toHaveBeenCalled();
    expect(f.supervisor.authorizePersonalOwner).not.toHaveBeenCalled();
  });
  it("denies changed owner birth and never creates an owner to satisfy proof", async () => {
    const f = fixture();
    f.supervisor.authorizePersonalOwner.mockRejectedValue(
      new Error("PEER_DENIED"),
    );
    await expect(
      dispatchPersonalOwnerProof(
        encode(
          personalOwnerProofCommand({
            ...request,
            peer: { ...peer, creationTime: "133400000000000099" },
          }),
        ),
        authority,
        f,
      ),
    ).rejects.toThrow("PEER_DENIED");
    expect(f.personal.command).not.toHaveBeenCalled();
  });
  it.each(["owner", "source", "pending", "missing", "mime"])(
    "refuses %s mismatch",
    async (caseName) => {
      const f = fixture();
      if (caseName === "owner") f.job.ownerId = randomUUID();
      if (caseName === "source")
        f.job.source = { kind: "youtube", videoId: "abcdefghijk" };
      if (caseName === "pending") f.job.state = "preparing";
      if (caseName === "missing") f.job.vocals = null;
      if (caseName === "mime")
        f.job.vocals!.contentType = "application/octet-stream";
      await expect(
        dispatchPersonalOwnerProof(
          encode(personalOwnerProofCommand(request)),
          authority,
          f,
        ),
      ).rejects.toThrow("PEER_DENIED");
    },
  );
  it("rejects duplicate/unknown fields and oversized proof commands before peer verification", async () => {
    const f = fixture(),
      value = personalOwnerProofCommand(request);
    for (const bytes of [
      encode({ ...value, token: "secret" }),
      Buffer.from(
        JSON.stringify(value).replace('"version":1', '"version":1,"version":1'),
      ),
      Buffer.alloc(4097),
    ])
      await expect(
        dispatchPersonalOwnerProof(bytes, authority, f),
      ).rejects.toThrow();
    expect(f.native.verifyPersonalOwnerProofPeers).not.toHaveBeenCalled();
  });
  it("does not expose owner-proof through a dispatcher lacking native authenticated peer support", async () => {
    const f = fixture(),
      dispatcher = createSessionDispatcher(
        f.supervisor as unknown as SessionSupervisor,
        f.personal as unknown as PersonalAgentClient,
        { dispatch: vi.fn() },
      );
    await expect(
      dispatcher.dispatch(
        encode(personalOwnerProofCommand(request)),
        authority,
      ),
    ).rejects.toThrow("PEER_DENIED");
    expect(f.personal.command).not.toHaveBeenCalled();
  });
});

describe("trusted desktop owner-kind playback proof", () => {
  it("queries only guest and then current trusted account scope, retaining stored desktop owner-kind fence", async () => {
    const f = fixture(),
      scope = { firebaseUid: "fixture-account", generation: randomUUID() },
      personalCommand = vi
        .fn()
        .mockResolvedValueOnce({
          version: 1,
          requestId: randomUUID(),
          ok: true,
          jobs: [],
        })
        .mockResolvedValueOnce({
          version: 1,
          requestId: randomUUID(),
          ok: true,
          jobs: [f.job],
        });
    const reply = JSON.parse(
      (
        await dispatchPersonalOwnerProof(
          encode(
            personalOwnerProofCommand({ ...request, ownerKind: "desktop" }),
          ),
          authority,
          {
            ...f,
            personal: { command: personalCommand },
            supervisor: { ...f.supervisor, currentAccountScope: () => scope },
          },
        )
      ).toString(),
    );
    expect(reply.proof.owner_kind).toBe("desktop");
    expect(f.native.verifyPersonalOwnerProofPeers).toHaveBeenCalledWith(
      authority,
      peer,
      "desktop",
    );
    expect(f.supervisor.authorizePersonalOwner).toHaveBeenCalledWith(
      request.ownerId,
      peer,
      "desktop",
    );
    expect(personalCommand.mock.calls.map((call) => call[2])).toEqual([
      null,
      scope,
    ]);
  });
  it("cannot select an old account generation or claim another owner kind in a proof", async () => {
    const f = fixture(),
      command = personalOwnerProofCommand({ ...request, ownerKind: "desktop" });
    await expect(
      dispatchPersonalOwnerProof(
        encode({
          ...command,
          account_scope: { firebaseUid: "old", generation: randomUUID() },
        }),
        authority,
        f,
      ),
    ).rejects.toThrow("INVALID_COMMAND");
    f.supervisor.authorizePersonalOwner.mockRejectedValue(
      new Error("PEER_DENIED"),
    );
    await expect(
      dispatchPersonalOwnerProof(encode(command), authority, f),
    ).rejects.toThrow("PEER_DENIED");
    expect(f.personal.command).not.toHaveBeenCalled();
  });
});
