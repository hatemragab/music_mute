import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createInstallerMaintenanceHandler,
  parseInstallerMaintenanceCommand,
} from "../src/main/browser/installer-maintenance.js";
const issuer = {
  sid: "S-1-5-21-1-2-3-1001",
  sessionId: 1,
  pid: 32,
  creationTime: "133400000000000001",
};
const pin = {
  sha256: "a".repeat(64),
  bytes: 100,
  publisherSha256: "b".repeat(64),
};
const command = (action: "install" | "uninstall" | "register" = "install") => ({
  version: 1 as const,
  request_id: randomUUID(),
  action,
});
function fixture() {
  const reservation = {
    assertIdle: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  const options = {
    native: {
      verifyInstallerMaintenancePeer: vi.fn(async () => ({
        issuer,
        certificateNonce: "c".repeat(64),
      })),
    },
    pin,
    reserve: vi.fn(async () => reservation),
    unregisterOwned: vi.fn(async () => {}),
    registerOwned: vi.fn(async () => {}),
    retire: vi.fn(async () => {}),
  };
  return {
    reservation,
    options,
    handler: createInstallerMaintenanceHandler(options),
  };
}
describe("private installer maintenance (injected signed native boundary, no installer)", () => {
  it("accepts only fixed versioned actions and refuses raw argv/extra fields", () => {
    expect(parseInstallerMaintenanceCommand(command("register")).action).toBe(
      "register",
    );
    for (const row of [
      "--installer-maintenance uninstall",
      { ...command(), action: "delete" },
      { ...command(), path: "C:\\arbitrary" },
      { ...command(), version: 2 },
    ])
      expect(() => parseInstallerMaintenanceCommand(row)).toThrow(
        "PEER_DENIED",
      );
  });
  it("checks real issuer before reservation and passes exact certified context", async () => {
    const f = fixture(),
      request = command();
    const reply = await f.handler.execute(
      request,
      issuer,
      new AbortController().signal,
    );
    expect(reply.ok).toBe(true);
    expect(
      f.options.native.verifyInstallerMaintenancePeer,
    ).toHaveBeenCalledWith(issuer, "install", pin);
    expect(f.options.reserve).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/u),
      expect.any(AbortSignal),
      { action: "install", issuer, certificateNonce: "c".repeat(64) },
    );
    expect(f.reservation.commit).not.toHaveBeenCalled();
    expect(f.options.retire).not.toHaveBeenCalled();
  });
  it("forged peer or actual activity refuses mutation and never forces cleanup", async () => {
    const f = fixture();
    f.options.native.verifyInstallerMaintenancePeer.mockRejectedValueOnce(
      new Error("PEER_DENIED"),
    );
    expect(
      await f.handler.execute(
        command("uninstall"),
        issuer,
        AbortSignal.timeout(1000),
      ),
    ).toMatchObject({ ok: false, error_code: "PEER_DENIED" });
    expect(f.options.reserve).not.toHaveBeenCalled();
    f.reservation.assertIdle.mockRejectedValueOnce(new Error("UPDATE_BUSY"));
    expect(
      await f.handler.execute(
        command("uninstall"),
        issuer,
        AbortSignal.timeout(1000),
      ),
    ).toMatchObject({ ok: false, error_code: "INSTALLER_BUSY" });
    expect(f.options.unregisterOwned).not.toHaveBeenCalled();
    expect(f.reservation.release).toHaveBeenCalledOnce();
    expect(f.options.retire).not.toHaveBeenCalled();
  });
  it("holds reservation after uncertain reply and replays only exact issuer/request", async () => {
    const f = fixture(),
      request = command("uninstall"),
      reply = await f.handler.execute(
        request,
        issuer,
        AbortSignal.timeout(1000),
      );
    expect(f.options.unregisterOwned).toHaveBeenCalledOnce();
    expect(
      await f.handler.execute(request, issuer, AbortSignal.timeout(1000)),
    ).toEqual(reply);
    expect(
      await f.handler.execute(command(), issuer, AbortSignal.timeout(1000)),
    ).toMatchObject({ ok: false, error_code: "INSTALLER_BUSY" });
    expect(f.reservation.release).not.toHaveBeenCalled();
    expect(f.reservation.commit).not.toHaveBeenCalled();
    await Promise.all([
      f.handler.acknowledged(reply),
      f.handler.acknowledged(reply),
    ]);
    expect(f.reservation.commit).toHaveBeenCalledOnce();
    expect(f.options.retire).toHaveBeenCalledOnce();
  });
  it("registers only after proof and cannot retire or admit fake ACK", async () => {
    const f = fixture(),
      reply = await f.handler.execute(
        command("register"),
        issuer,
        AbortSignal.timeout(1000),
      );
    expect(f.options.registerOwned).toHaveBeenCalledOnce();
    expect(f.options.reserve).not.toHaveBeenCalled();
    await f.handler.acknowledged(reply);
    expect(f.options.retire).not.toHaveBeenCalled();
    await expect(
      f.handler.acknowledged({
        version: 1,
        request_id: randomUUID(),
        ok: true,
        transaction: "d".repeat(64),
        action: "uninstall",
      }),
    ).rejects.toThrow("PEER_DENIED");
  });
});
