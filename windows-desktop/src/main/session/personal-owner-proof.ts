import { randomUUID } from "node:crypto";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  processIdentityFromWire,
  processIdentityToWire,
  sameConsumerProcess,
  type ConsumerProcessIdentity,
  type WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { PersonalAgentClient } from "../personal/session-port.js";
import type { SessionSupervisor } from "./supervisor.js";
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export interface PersonalPlaybackOwnerRequest {
  ownerId: string;
  jobId: string;
  videoId: string;
  peer: ConsumerProcessIdentity;
  ownerKind?: "desktop" | "chrome";
}
export interface PersonalPlaybackOwnerProof {
  version: 1;
  owner_id: string;
  owner_kind: "desktop" | "chrome";
  job_id: string;
  video_id: string;
  peer: ConsumerProcessIdentity;
  vocals: {
    artifact_id: string;
    sha256: string;
    bytes: number;
    duration_seconds: number;
    content_type: "audio/mpeg";
  };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PEER_DENIED");
  return value as Record<string, unknown>;
}
export function personalOwnerProofCommand(
  request: PersonalPlaybackOwnerRequest,
) {
  if (
    !UUID.test(request.ownerId) ||
    !UUID.test(request.jobId) ||
    !/^[A-Za-z0-9_-]{11}$/u.test(request.videoId) ||
    (request.ownerKind !== undefined &&
      !["desktop", "chrome"].includes(request.ownerKind))
  )
    throw new Error("INVALID_COMMAND");
  return {
    version: 1,
    kind: "personal-owner-proof",
    request_id: randomUUID(),
    owner_id: request.ownerId,
    owner_kind: request.ownerKind ?? "chrome",
    job_id: request.jobId,
    video_id: request.videoId,
    original_peer: processIdentityFromWire(processIdentityToWire(request.peer)),
  };
}
export function parsePersonalOwnerProof(
  value: unknown,
  expected: PersonalPlaybackOwnerRequest,
): PersonalPlaybackOwnerProof {
  const row = record(value),
    vocals = record(row.vocals),
    peer = processIdentityFromWire(
      processIdentityToWire(row.peer as ConsumerProcessIdentity),
    );
  if (
    Object.keys(row).sort().join() !==
      "job_id,owner_id,owner_kind,peer,version,video_id,vocals" ||
    row.version !== 1 ||
    row.owner_id !== expected.ownerId ||
    row.owner_kind !== (expected.ownerKind ?? "chrome") ||
    row.job_id !== expected.jobId ||
    row.video_id !== expected.videoId ||
    !sameConsumerProcess(peer, expected.peer) ||
    Object.keys(vocals).sort().join() !==
      "artifact_id,bytes,content_type,duration_seconds,sha256" ||
    typeof vocals.artifact_id !== "string" ||
    !UUID.test(vocals.artifact_id) ||
    typeof vocals.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(vocals.sha256) ||
    !Number.isSafeInteger(vocals.bytes) ||
    (vocals.bytes as number) < 1 ||
    (vocals.bytes as number) > 256 * 1024 ** 2 ||
    typeof vocals.duration_seconds !== "number" ||
    !Number.isFinite(vocals.duration_seconds) ||
    vocals.duration_seconds <= 0 ||
    vocals.duration_seconds > 1200 ||
    vocals.content_type !== "audio/mpeg"
  )
    throw new Error("PEER_DENIED");
  return {
    version: 1,
    owner_id: expected.ownerId,
    owner_kind: expected.ownerKind ?? "chrome",
    job_id: expected.jobId,
    video_id: expected.videoId,
    peer,
    vocals: structuredClone(
      vocals,
    ) as unknown as PersonalPlaybackOwnerProof["vocals"],
  };
}
/** Read-only: never attaches an owner or launches a role to manufacture a proof. */
export async function dispatchPersonalOwnerProof(
  payload: Uint8Array,
  authority: ConsumerProcessIdentity,
  ports: {
    native: Pick<WindowsConsumerNative, "verifyPersonalOwnerProofPeers">;
    supervisor: Pick<SessionSupervisor, "authorizePersonalOwner"> &
      Partial<Pick<SessionSupervisor, "currentAccountScope">>;
    personal: Pick<PersonalAgentClient, "command">;
  },
): Promise<Buffer> {
  if (payload.byteLength > 4096) throw new Error("INVALID_COMMAND");
  const row = record(
    parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(payload),
      4096,
    ),
  );
  if (
    Object.keys(row).sort().join() !==
      "job_id,kind,original_peer,owner_id,owner_kind,request_id,version,video_id" ||
    row.version !== 1 ||
    row.kind !== "personal-owner-proof" ||
    typeof row.request_id !== "string" ||
    !UUID.test(row.request_id) ||
    typeof row.owner_id !== "string" ||
    typeof row.job_id !== "string" ||
    typeof row.video_id !== "string" ||
    (row.owner_kind !== "desktop" && row.owner_kind !== "chrome")
  )
    throw new Error("INVALID_COMMAND");
  const requested: PersonalPlaybackOwnerRequest = {
    ownerId: row.owner_id,
    jobId: row.job_id,
    videoId: row.video_id,
    ownerKind: row.owner_kind,
    peer: processIdentityFromWire(
      processIdentityToWire(row.original_peer as ConsumerProcessIdentity),
    ),
  };
  personalOwnerProofCommand(requested);
  if (
    !(await ports.native.verifyPersonalOwnerProofPeers(
      authority,
      requested.peer,
      requested.ownerKind!,
    ))
  )
    throw new Error("PEER_DENIED");
  await ports.supervisor.authorizePersonalOwner(
    requested.ownerId,
    requested.peer,
    requested.ownerKind,
  );
  let reply = await ports.personal.command(
    {
      version: 1,
      requestId: randomUUID(),
      action: "jobs",
      ownerId: requested.ownerId,
    },
    requested.peer,
    null,
  );
  if (
    requested.ownerKind === "desktop" &&
    reply.ok &&
    Array.isArray(reply.jobs) &&
    !reply.jobs.some((view) => view.id === requested.jobId)
  ) {
    const scope = ports.supervisor.currentAccountScope?.();
    if (scope)
      reply = await ports.personal.command(
        {
          version: 1,
          requestId: randomUUID(),
          action: "jobs",
          ownerId: requested.ownerId,
        },
        requested.peer,
        scope,
      );
  }
  if (!reply.ok || !Array.isArray(reply.jobs)) throw new Error("PEER_DENIED");
  const job = reply.jobs.find((view) => view.id === requested.jobId);
  if (
    !job ||
    job.ownerId !== requested.ownerId ||
    job.state !== "ready" ||
    job.source?.kind !== "youtube" ||
    job.source.videoId !== requested.videoId ||
    job.vocals?.kind !== "vocals"
  )
    throw new Error("PEER_DENIED");
  const proof = parsePersonalOwnerProof(
    {
      version: 1,
      owner_id: job.ownerId,
      owner_kind: requested.ownerKind,
      job_id: job.id,
      video_id: job.source.videoId,
      peer: requested.peer,
      vocals: {
        artifact_id: job.vocals.id,
        sha256: job.vocals.sha256,
        bytes: job.vocals.bytes,
        duration_seconds: job.vocals.durationSeconds,
        content_type: job.vocals.contentType,
      },
    },
    requested,
  );
  return Buffer.from(
    JSON.stringify({ version: 1, request_id: row.request_id, ok: true, proof }),
  );
}
