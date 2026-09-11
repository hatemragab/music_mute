import type { WorkerSummary } from "@/api/contracts";

export const workerCapacityLabel = (worker: WorkerSummary) => {
  if (worker.recoveryRequired) return "Recovery required";
  if (worker.activeAttemptId)
    return worker.online
      ? "Processing reserved work"
      : "Offline with reserved work";
  if (worker.state === "draining") return "Draining; no new work";
  if (worker.state === "revoked") return "Credentials revoked";
  return worker.online ? "Available" : "Offline";
};
