import { describe, expect, it, vi } from "vitest";
import { StoreSessionClient } from "../src/main/session/store-session-client.js";
import {
  StoreGuiCpuOperation,
  StoreGuiMediaExecution,
} from "../src/main/session/store-gui-media.js";
import type { HostContext } from "../src/main/host-context.js";
import type { StoreMediaRequest } from "../src/shared/store-media-request.js";

describe("GUI CPU factory authority boundary", () => {
  it("rejects a Session prototype clone before invoking caller IO or request getters", () => {
    const io = vi.fn(),
      getter = vi.fn(() => "cloud_probe");
    const fake = Object.assign(Object.create(StoreSessionClient.prototype), {
      assertMediaHost: io,
      mediaOperationCommand: io,
    }) as StoreSessionClient;
    const request = {
      get configuration() {
        return getter();
      },
    } as unknown as StoreMediaRequest;
    expect(() =>
      StoreGuiCpuOperation.create({} as HostContext, fake, request),
    ).toThrow();
    expect(() =>
      StoreGuiMediaExecution.create({} as HostContext, fake, request),
    ).toThrow();
    expect(io).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });
  it("receiving expectation fields cannot construct a cleanup or start capability", () => {
    const fake = Object.assign(Object.create(StoreGuiCpuOperation.prototype), {
      expectation: {
        version: 1,
        distribution: "microsoft-store",
        retired: true,
      },
      session: { mediaOperationCommand: vi.fn() },
      host: {},
      closed: true,
    }) as StoreGuiCpuOperation;
    expect(() =>
      StoreGuiCpuOperation.prototype.expectation.call(fake),
    ).toThrow();
    expect(() =>
      StoreGuiCpuOperation.prototype.closedForSession.call(
        fake,
        {} as StoreSessionClient,
      ),
    ).toThrow();
    expect(() =>
      StoreGuiCpuOperation.prototype.assertHost.call(fake, {} as HostContext),
    ).toThrow();
    expect(() =>
      StoreGuiCpuOperation.prototype.run.call(
        fake,
        new AbortController().signal,
      ),
    ).toThrow();
    expect(() => StoreGuiCpuOperation.prototype.close.call(fake)).toThrow();
  });
  it("does not accept a caller success function or DTO execution instance", () => {
    const success = vi.fn(() => Promise.resolve());
    const fake = Object.assign(
      Object.create(StoreGuiMediaExecution.prototype),
      {
        operation: { prepare: success, run: success, close: success },
      },
    ) as StoreGuiMediaExecution;
    expect(() =>
      StoreGuiMediaExecution.prototype.operation.call(fake),
    ).toThrow();
    expect(() =>
      StoreGuiMediaExecution.prototype.run.call(
        fake,
        new AbortController().signal,
      ),
    ).toThrow();
    expect(() => StoreGuiMediaExecution.prototype.close.call(fake)).toThrow();
    expect(success).not.toHaveBeenCalled();
  });
  it("refuses a forged client media factory without executing supplied callbacks", async () => {
    const io = vi.fn();
    const fake = Object.assign(Object.create(StoreSessionClient.prototype), {
      command: io,
      revalidate: io,
      openMedia: io,
    }) as StoreSessionClient;
    await expect(
      StoreSessionClient.prototype.openMedia.call(fake, {
        operation: "diagnostics_doctor",
      }),
    ).rejects.toThrow();
    expect(io).not.toHaveBeenCalled();
  });
});
