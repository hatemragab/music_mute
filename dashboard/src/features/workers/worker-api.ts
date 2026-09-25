import type { ApiClient } from "@/api/api-client";
import type { RevisionCommand } from "@/api/contracts";
import { withQuery } from "@/api/query-string";
import type {
  WorkerDiagnosticPage,
  WorkerFleetPolicy,
  WorkerInvitationCredential,
  WorkerInvitationPage,
  WorkerMachineDetail,
  WorkerMachinePage,
  WorkerMachineStatus,
  WorkerPlatform,
} from "./worker-types";

export const listWorkerMachines = (
  client: ApiClient,
  options: {
    status?: WorkerMachineStatus;
    groupId?: string;
    platform?: WorkerPlatform;
    releaseVersion?: string;
    cursor?: string | null;
    limit?: number;
  } = {},
) =>
  client.get<WorkerMachinePage>(
    withQuery("/admin/worker-fleet/machines", options),
  );

export const getWorkerMachine = (client: ApiClient, machineId: string) =>
  client.get<WorkerMachineDetail>(
    `/admin/worker-fleet/machines/${encodeURIComponent(machineId)}`,
  );

export const getWorkerDiagnostics = (
  client: ApiClient,
  machineId: string,
  options: { cursor?: string | null; limit?: number } = {},
) =>
  client.get<WorkerDiagnosticPage>(
    withQuery(
      `/admin/worker-fleet/machines/${encodeURIComponent(machineId)}/diagnostics`,
      options,
    ),
  );

export const listWorkerInvitations = (
  client: ApiClient,
  options: { cursor?: string | null; limit?: number } = {},
) =>
  client.get<WorkerInvitationPage>(
    withQuery("/admin/worker-fleet/invitations", options),
  );

export const createWorkerInvitation = (
  client: ApiClient,
  input: {
    operationId: string;
    expiresInSeconds: number;
    initialPolicyId?: string;
    reason: string;
  },
) =>
  client.post<WorkerInvitationCredential>("/admin/workers/invitations", input);

export const revokeWorkerInvitation = (
  client: ApiClient,
  invitationId: string,
  input: RevisionCommand,
) =>
  client.post<{ invitationId: string; revision: number; replayed: boolean }>(
    `/admin/workers/invitations/${encodeURIComponent(invitationId)}/revocations`,
    input,
  );

export const changeWorkerMachineState = (
  client: ApiClient,
  machineId: string,
  action: "pause" | "drain" | "resume" | "revoke",
  input: RevisionCommand,
) =>
  client.post<{
    machineId: string;
    revision: number;
    status: WorkerMachineStatus;
    replayed: boolean;
  }>(
    `/admin/workers/machines/${encodeURIComponent(machineId)}/${
      {
        pause: "pauses",
        drain: "drains",
        resume: "resumptions",
        revoke: "revocations",
      }[action]
    }`,
    input,
  );

export const requestWorkerDoctor = (
  client: ApiClient,
  machineId: string,
  input: RevisionCommand & { checks: string[] },
) =>
  client.post<{ commandId: string; deferred: boolean; replayed: boolean }>(
    `/admin/worker-fleet/machines/${encodeURIComponent(machineId)}/diagnostic-runs`,
    input,
  );

export const requestWorkerBenchmark = (
  client: ApiClient,
  machineId: string,
  input: RevisionCommand & { recipeId: string; iterations: number },
) =>
  client.post<{ commandId: string; deferred: boolean; replayed: boolean }>(
    `/admin/worker-fleet/machines/${encodeURIComponent(machineId)}/benchmark-runs`,
    input,
  );

export const getWorkerFleetPolicy = (client: ApiClient) =>
  client.get<WorkerFleetPolicy>("/admin/worker-fleet/policy");

export const updateWorkerFleetPolicy = (
  client: ApiClient,
  input: RevisionCommand &
    Pick<
      WorkerFleetPolicy,
      | "acceptClaims"
      | "recipes"
      | "leaseSeconds"
      | "processingDeadlineSeconds"
      | "maxAttempts"
    >,
) =>
  client.put<{ revision: number; replayed: boolean }>(
    "/admin/worker-fleet/policy",
    input,
  );
