import { describe, expect, it } from "vitest";
import { StoreSessionClient } from "../src/main/session/store-session-client.js";
import {
  parseStorePrepareLaunch,
  parseStorePrepareLaunchResult,
  parseStorePrepareEvent,
  parseStoreSessionObservation,
  STORE_PREPARE_FAILURE_CODES,
} from "../src/shared/store-prepare-contracts.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { gpu, sid, bootIdentity, receipt } from "./fixtures/prepare.js";
const product = STORE_PRODUCTS.worker,
  bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
const request = parseStorePrepareLaunch(
  bytes({
    version: 1,
    requestId: "12345678-1234-4234-8234-123456789012",
    operation: "qualify",
    binding: {
      package: {
        identityName: product.identityName,
        publisher: product.publisher,
        publisherId: product.publisherId,
        familyName: product.familyName,
        fullName: `${product.identityName}_0.1.3.2_x64__${product.publisherId}`,
        packageVersion: "0.1.3.2",
        architecture: "x64",
        signatureKind: 3,
        healthy: true,
        current: true,
        installedLocation: `C:\\Program Files\\WindowsApps\\${product.identityName}_0.1.3.2_x64__${product.publisherId}`,
      },
      inventorySha256: "c".repeat(64),
      runtimeManifestSha256: "b".repeat(64),
      sid,
      bootIdentity,
      recipeDigests: {
        "kim-vocals-v2": "0".repeat(64),
        "kim-vocals-v2-trim": "1".repeat(64),
      },
    },
    gpu,
    fixture: { kind: "fixed" },
  }),
);
const owner = {
    role: "prepare",
    nonce: "a".repeat(64),
    identity: {
      sid,
      sessionId: 1,
      pid: 345,
      creationTime: "132000000000000000",
    },
  },
  launch = parseStorePrepareLaunchResult(
    bytes({
      version: 1,
      requestId: request.requestId,
      owner,
      inventorySha256: request.binding.inventorySha256,
    }),
    request,
  );
const observation = {
  version: 1,
  owner: { ...owner, role: "session-agent" },
  creator: { ...owner.identity, pid: 123, creationTime: "131000000000000000" },
  inventorySha256: request.binding.inventorySha256,
};
describe("Store Session client actual-factory boundary", () => {
  it("receives only closed typed failure events without minting cleanup or readiness", () => {
    for (const errorCode of STORE_PREPARE_FAILURE_CODES) {
      const event = parseStorePrepareEvent(
        bytes({ ...launch, state: "failed", errorCode }),
        request,
        launch,
      );
      expect(event).toMatchObject({ state: "failed", errorCode });
      expect(event).not.toHaveProperty("result");
      expect(event).not.toHaveProperty("job");
    }
    for (const changed of [
      { errorCode: "PASS" },
      { errorCode: null },
      { errorCode: "CPU_FALLBACK" },
      { errorCode: "GPU_UNSUPPORTED", job: "confirmed" },
      { errorCode: "GPU_UNSUPPORTED", result: receipt().qualification },
      {
        errorCode: "GPU_UNSUPPORTED",
        owner: { ...launch.owner, nonce: "f".repeat(64) },
      },
    ])
      expect(() =>
        parseStorePrepareEvent(
          bytes({ ...launch, state: "failed", ...changed }),
          request,
          launch,
        ),
      ).toThrow("STORE_PREPARE_CONTRACT_DENIED");
  });
  it("denies caller JSON, private symbols and injected transport construction", async () => {
    for (const token of [Symbol("caller"), undefined, { receipt: observation }])
      expect(() =>
        Reflect.construct(StoreSessionClient, [
          token,
          {},
          {},
          {},
          request.binding,
          observation,
        ]),
      ).toThrow("STORE_SESSION_CLIENT_DENIED");
    const forged = Object.create(StoreSessionClient.prototype);
    expect(() =>
      StoreSessionClient.prototype.assertCodeAuthority.call(
        forged,
        {} as never,
      ),
    ).toThrow();
    if (process.platform !== "win32" || process.arch !== "x64")
      await expect(
        StoreSessionClient.open({} as never, {} as never),
      ).rejects.toThrow("STORE_SESSION_CLIENT_DENIED");
  });
  it("receives only matching actual-observation shaped data without minting a session client", () => {
    const result = parseStoreSessionObservation(
      bytes(observation),
      request.binding,
      1,
    );
    expect(result).not.toBeInstanceOf(StoreSessionClient);
    expect(result).not.toHaveProperty("launchPrepare");
    expect(Object.isFrozen(result.owner.identity)).toBe(true);
    for (const changed of [
      { inventorySha256: "d".repeat(64) },
      { owner: { ...observation.owner, role: "personal" } },
      { creator: { ...observation.creator, sessionId: 2 } },
      { creator: observation.owner.identity },
      { clientCapability: "d".repeat(64) },
      { startup: true },
    ])
      expect(() =>
        parseStoreSessionObservation(
          bytes({ ...observation, ...changed }),
          request.binding,
          1,
        ),
      ).toThrow("STORE_PREPARE_CONTRACT_DENIED");
  });
  it("keeps bounded event-wait expiry distinct from a completed qualification and cleanup", () => {
    const waiting = { ...launch, state: "waiting" };
    expect(parseStorePrepareEvent(bytes(waiting), request, launch).state).toBe(
      "waiting",
    );
    const result = {
      ...launch,
      operation: "qualify",
      bootIdentity,
      raw: receipt().qualification,
    };
    expect(
      parseStorePrepareEvent(
        bytes({ ...launch, state: "completed", result }),
        request,
        launch,
      ).state,
    ).toBe("completed");
    for (const bad of [
      { ...waiting, result },
      { ...launch, state: "completed" },
      { ...waiting, state: "ready" },
      { ...waiting, owner: { ...launch.owner, nonce: "d".repeat(64) } },
      {
        ...launch,
        state: "completed",
        result: { ...result, bootIdentity: "d".repeat(64) },
      },
    ])
      expect(() => parseStorePrepareEvent(bytes(bad), request, launch)).toThrow(
        "STORE_PREPARE_CONTRACT_DENIED",
      );
    expect(
      parseStorePrepareEvent(bytes(waiting), request, launch),
    ).not.toHaveProperty("job");
  });
});
