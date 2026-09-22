import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "@/api/api-client";
import {
  changeWorkerMachineState,
  createWorkerInvitation,
  getWorkerDiagnostics,
  listWorkerMachines,
  requestWorkerBenchmark,
  updateWorkerFleetPolicy,
} from "./worker-api";

const client = () =>
  ({
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
  }) as unknown as ApiClient;

describe("worker dashboard API contracts", () => {
  it("encodes server-side fleet filters and cursors", async () => {
    const api = client();
    await listWorkerMachines(api, {
      status: "active",
      platform: "windows-amd64",
      groupId: "studio a",
      releaseVersion: "0.1.3",
      cursor: "cursor-value",
      limit: 25,
    });

    expect(api.get).toHaveBeenCalledWith(
      "/admin/worker-fleet/machines?status=active&platform=windows-amd64&groupId=studio+a&releaseVersion=0.1.3&cursor=cursor-value&limit=25",
    );
  });

  it("uses the accepted enrollment, lifecycle and diagnostics routes", async () => {
    const api = client();
    const command = {
      operationId: "2bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29",
      expectedRevision: 4,
      reason: "Synthetic contract fixture",
    };

    await createWorkerInvitation(api, {
      operationId: command.operationId,
      expiresInSeconds: 900,
      reason: command.reason,
    });
    await changeWorkerMachineState(api, "machine/unsafe", "drain", command);
    await getWorkerDiagnostics(api, "machine/unsafe");
    await requestWorkerBenchmark(api, "machine/unsafe", {
      ...command,
      recipeId: "kim-vocals-v2",
      iterations: 1,
    });

    expect(api.post).toHaveBeenNthCalledWith(
      1,
      "/admin/workers/invitations",
      expect.objectContaining({ expiresInSeconds: 900 }),
    );
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      "/admin/workers/machines/machine%2Funsafe/drain",
      command,
    );
    expect(api.get).toHaveBeenCalledWith(
      "/admin/worker-fleet/machines/machine%2Funsafe/diagnostics",
    );
    expect(api.post).toHaveBeenNthCalledWith(
      3,
      "/admin/worker-fleet/machines/machine%2Funsafe/benchmark",
      expect.objectContaining({ recipeId: "kim-vocals-v2" }),
    );
  });

  it("sends revision-fenced policy capacity", async () => {
    const api = client();
    const input = {
      operationId: "2bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29",
      expectedRevision: 7,
      reason: "Adjust qualified capacity",
      acceptClaims: true,
      recipes: [
        {
          recipeId: "kim-vocals-v2",
          enabled: true,
          maxSlotsPerMachine: 1,
        },
      ],
      leaseSeconds: 60,
      processingDeadlineSeconds: 900,
      maxAttempts: 3,
    };
    await updateWorkerFleetPolicy(api, input);

    expect(api.put).toHaveBeenCalledWith("/admin/worker-fleet/policy", input);
  });
});
