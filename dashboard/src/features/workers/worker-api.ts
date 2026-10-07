import {
  type ApiClient,
  OperationOutcomeUnknownError,
  submitWithReceiptReadBack,
} from "@/api/api-client";
import type { OperationReceipt, RevisionCommand } from "@/api/contracts";
import { withQuery } from "@/api/query-string";
import type {
  WorkerDiagnosticPage,
  WorkerFleetPolicy,
  WorkerMachineDetail,
  WorkerMachinePage,
  WorkerMachineStatus,
  WorkerPlatform,
  DeleteWorkerMachineCommand,
} from "./worker-types";

export const deleteWorkerMachine = (
  client: ApiClient,
  machineId: string,
  input: DeleteWorkerMachineCommand,
) => {
  const confirmed = (receipt: OperationReceipt) => {
    if (
      receipt?.operationId !== input.operationId ||
      receipt.status !== "succeeded" ||
      receipt.resourceId !== machineId ||
      !Number.isSafeInteger(receipt.revision) ||
      (receipt.revision ?? -1) < 0
    )
      throw new OperationOutcomeUnknownError(
        input.operationId,
        "The deletion response is unresolved. Check its operation outcome before making another change.",
      );
    return receipt;
  };
  return submitWithReceiptReadBack<OperationReceipt>({
    client,
    operationId: input.operationId,
    submit: async () => {
      try {
        return confirmed(
          await client.post<OperationReceipt>(
            `/admin/workers/machines/${encodeURIComponent(machineId)}/deletions`,
            input,
          ),
        );
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new OperationOutcomeUnknownError(
            input.operationId,
            "The deletion response could not be decoded. Check its operation outcome before retrying.",
            error,
          );
        throw error;
      }
    },
    readResult: async (receipt) => confirmed(receipt),
  });
};

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

interface WorkerCommandReceipt {
  commandId: string;
  deferred: boolean | null;
  replayed: boolean;
}

const submitWorkerCommand = (
  client: ApiClient,
  machineId: string,
  kind: "diagnostic-runs" | "benchmark-runs",
  input: RevisionCommand &
    ({ checks: string[] } | { recipeId: string; iterations: number }),
) =>
  submitWithReceiptReadBack<WorkerCommandReceipt>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post(
        `/admin/worker-fleet/machines/${encodeURIComponent(machineId)}/${kind}`,
        input,
      ),
    readResult: async (receipt) => {
      const detail = await getWorkerMachine(client, machineId);
      const command = detail.commands.find(
        (item) => item.commandId === receipt.resourceId,
      );
      if (!command)
        throw new Error("Command is outside the recent history window.");
      return { commandId: command.commandId, deferred: null, replayed: true };
    },
  });

export const requestWorkerDoctor = (
  client: ApiClient,
  machineId: string,
  input: RevisionCommand & { checks: string[] },
) => submitWorkerCommand(client, machineId, "diagnostic-runs", input);

export const requestWorkerBenchmark = (
  client: ApiClient,
  machineId: string,
  input: RevisionCommand & { recipeId: string; iterations: number },
) => submitWorkerCommand(client, machineId, "benchmark-runs", input);

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

export const approveWorkerCapacity = (
  client: ApiClient,
  machineId: string,
  input: RevisionCommand & { gpuId: string; qualificationConfirmed: true },
) =>
  client.post<{
    machineId: string;
    revision: number;
    maxSlots: number;
    replayed: boolean;
  }>(
    `/admin/worker-fleet/machines/${encodeURIComponent(machineId)}/capacity-approvals`,
    input,
  );
