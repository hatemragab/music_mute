import { expect, it, vi } from "vitest";
import { readStoreRoleReadiness } from "../src/main/prepare/store-readiness.js";
import { StoreNodeIssuer } from "../src/main/session/store-node-issuer.js";
import { StorePersonalRuntime } from "../src/main/personal/store-runtime.js";
import type { HostContext } from "../src/main/host-context.js";
import {
  PersonalAgentClient,
  createPersonalSessionPort,
} from "../src/main/personal/session-port.js";
import { PersonalCommandRouter } from "../src/main/personal/server.js";
import { DirectmlPersonalRunner } from "../src/main/personal/runner.js";
import {
  readCurrentPersonalGpu,
  readCurrentFleetGpu,
} from "../src/main/admission/current-gpu.js";
import { createQualifiedSessionGpuAdmission } from "../src/main/admission/session-admission.js";

it("cannot read or admit Store model state from a forged Node issuer or its overridden methods", async () => {
  const vaultRead = vi.fn(),
    codeView = vi.fn(async () => ({ binding: { signatureKind: 3 } })),
    assertNative = vi.fn(),
    native = { vaultRead },
    host = { native } as unknown as HostContext,
    issuer = Object.assign(Object.create(StoreNodeIssuer.prototype), {
      assertNative,
      codeView,
    }) as StoreNodeIssuer;
  await expect(
    readStoreRoleReadiness(host, issuer, new AbortController().signal),
  ).rejects.toThrow();
  await expect(StorePersonalRuntime.open(host, issuer)).rejects.toThrow();
  expect(assertNative).not.toHaveBeenCalled();
  expect(codeView).not.toHaveBeenCalled();
  expect(vaultRead).not.toHaveBeenCalled();
});

it("rejects caller-built personal runtime/configuration before model or GPU operations", async () => {
  const native = { vaultRead: vi.fn(), enumerateGpus: vi.fn() },
    host = { native } as unknown as HostContext,
    configuration = { distribution: "microsoft-store" },
    forged = Object.assign(Object.create(StorePersonalRuntime.prototype), {
      configuration,
    }) as StorePersonalRuntime;
  expect(() =>
    Reflect.construct(StorePersonalRuntime, [
      Symbol("caller"),
      host,
      {},
      { signatureKind: 3 },
      configuration,
      { provider: "directml" },
    ]),
  ).toThrow("PREPARE_REQUIRED");
  expect(() =>
    StorePersonalRuntime.prototype.assertConfiguration.call(
      forged,
      host,
      configuration as never,
    ),
  ).toThrow();
  await expect(
    StorePersonalRuntime.prototype.assertCurrent.call(
      forged,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(native.vaultRead).not.toHaveBeenCalled();
  expect(native.enumerateGpus).not.toHaveBeenCalled();
});

it("cannot turn a Store-tagged context or an overridden issuer into a personal control client", async () => {
  const openNative = vi.fn(),
    requestControl = vi.fn(),
    vaultRead = vi.fn(),
    issuer = Object.assign(Object.create(StoreNodeIssuer.prototype), {
      requestControl,
      assertNative: vi.fn(),
    }),
    native = { vaultRead },
    context = {
      distribution: "microsoft-store",
      storeIssuer: issuer,
      native,
      openNative,
    };
  expect(() => PersonalAgentClient.forStore(issuer, native as never)).toThrow();
  await expect(createPersonalSessionPort(context as never)).rejects.toThrow();
  expect(openNative).not.toHaveBeenCalled();
  expect(requestControl).not.toHaveBeenCalled();
  expect(vaultRead).not.toHaveBeenCalled();
});

it("does not admit Store model/GPU observations through legacy readiness or caller callbacks", async () => {
  const vaultRead = vi.fn(),
    enumerateGpus = vi.fn(),
    openNative = vi.fn(),
    readRoleGpu = vi.fn(),
    native = { vaultRead, enumerateGpus },
    issuer = Object.create(StoreNodeIssuer.prototype),
    context = {
      distribution: "microsoft-store",
      storeIssuer: issuer,
      native,
      openNative,
    };
  for (const read of [readCurrentPersonalGpu, readCurrentFleetGpu])
    await expect(
      read(native as never, "a".repeat(64), issuer),
    ).rejects.toThrow();
  await expect(
    createQualifiedSessionGpuAdmission(
      context as never,
      { readRoleGpu } as never,
    ),
  ).rejects.toThrow("GPU_OWNER_DENIED");
  await expect(
    createQualifiedSessionGpuAdmission(
      { ...context, storeIssuer: undefined } as never,
      {} as never,
    ),
  ).rejects.toThrow("GPU_OWNER_DENIED");
  expect(vaultRead).not.toHaveBeenCalled();
  expect(enumerateGpus).not.toHaveBeenCalled();
  expect(openNative).not.toHaveBeenCalled();
  expect(readRoleGpu).not.toHaveBeenCalled();
});

it("a caller Store config cannot enable a runner, supplied child or controller router", () => {
  const child = vi.fn(),
    assertConfiguration = vi.fn(),
    runtime = Object.assign(Object.create(StorePersonalRuntime.prototype), {
      assertConfiguration,
    }),
    host = { native: {} },
    configuration = { distribution: "microsoft-store" },
    options = {
      host,
      configuration,
      storeRuntime: runtime,
      hardware: vi.fn(),
      admission: {},
    };
  expect(() => new DirectmlPersonalRunner(options as never)).toThrow();
  expect(
    () => new DirectmlPersonalRunner({ ...options, child } as never),
  ).toThrow("PREPARE_REQUIRED");
  expect(
    () =>
      new DirectmlPersonalRunner({ ...options, retainModel: false } as never),
  ).toThrow("PREPARE_REQUIRED");
  expect(
    () => new PersonalCommandRouter({} as never, configuration as never),
  ).toThrow("OWNER_DETACHED");
  expect(
    () =>
      new PersonalCommandRouter(
        {} as never,
        configuration as never,
        undefined,
        {
          issuer: Object.create(StoreNodeIssuer.prototype),
          native: {} as never,
        },
      ),
  ).toThrow();
  expect(child).not.toHaveBeenCalled();
  expect(assertConfiguration).not.toHaveBeenCalled();
});
