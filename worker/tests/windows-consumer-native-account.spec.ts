import { describe, expect, it, vi } from "vitest";
import {
  WindowsConsumerNative,
  type ConsumerNativeTransport,
  type ConsumerNativeOperation,
} from "../src/platform/windows/consumer-native.js";
const sid = "S-1-5-21-1-2-3-1001",
  peer = { sid, sessionId: 1, pid: 42, creationTime: "133400000000000001" },
  wire = { sid, session_id: 1, pid: 42, creation_time: peer.creationTime },
  host = {
    ...wire,
    logon_sid: "S-1-5-5-1-2",
    native_arch: "x64",
    process_arch: "x64",
    os_major: 10,
    os_build: 19045,
    local_app_data: "C:\\Users\\Fixture\\AppData\\Local",
  },
  pin = { sha256: "a".repeat(64), bytes: 64, publisherSha256: "b".repeat(64) };
function fixture(
  handler: (
    operation: ConsumerNativeOperation,
    args: Record<string, unknown>,
  ) => unknown = () => ({ verified: true }),
) {
  const request = vi.fn(
      async (
        operation: ConsumerNativeOperation,
        args: Record<string, unknown>,
      ) => (operation === "identity" ? host : handler(operation, args)),
    ),
    transport = {
      request,
      close: vi.fn(async () => {}),
    } satisfies ConsumerNativeTransport;
  return { native: new WindowsConsumerNative(transport), request };
}
describe("fixed signed account app SDK operations (injected native only)", () => {
  it("reads real bound-role inference idleness without replacing false/failed proof by guardian PID absence", async () => {
    let response: unknown = { idle: false };
    const f = fixture(() => response);
    expect(await f.native.inferenceIdle()).toBe(false);
    expect(f.request).toHaveBeenCalledWith("inference_idle", {});
    response = { idle: true };
    expect(await f.native.inferenceIdle()).toBe(true);
    response = { idle: true, pid_gone: true };
    await expect(f.native.inferenceIdle()).rejects.toThrow("PROTOCOL_MISMATCH");
  });
  it("requires exact signed installer issuer receipt and carries its certificate for authorized nested maintenance", async () => {
    const f = fixture(() => ({
      authorized: true,
      issuer: { ...wire, pid: 43 },
      certificate_nonce: "c".repeat(64),
    }));
    expect(
      await f.native.verifyInstallerMaintenancePeer(peer, "install", pin),
    ).toEqual({
      issuer: { ...peer, pid: 43 },
      certificateNonce: "c".repeat(64),
    });
    expect(f.request).toHaveBeenCalledWith(
      "installer_maintenance_peer_verify",
      {
        app_sha256: pin.sha256,
        app_bytes: 64,
        publisher_sha256: pin.publisherSha256,
        identity: wire,
        action: "install",
      },
      35000,
    );
    await expect(
      f.native.verifyInstallerMaintenancePeer(
        { ...peer, sessionId: 2 },
        "install",
        pin,
      ),
    ).rejects.toThrow("PEER_DENIED");
    const malformed = fixture(() => ({
      authorized: true,
      issuer: { ...wire, session_id: 2 },
      certificate_nonce: null,
    }));
    await expect(
      malformed.native.verifyInstallerMaintenancePeer(peer, "uninstall", pin),
    ).rejects.toThrow("PEER_DENIED");
  });
  it("registers only the fixed owned protocol and rejects extra/false success fields", async () => {
    const f = fixture((op) =>
      op === "protocol_register" ? { registered: true } : { removed: true },
    );
    await f.native.registerProtocol();
    await f.native.unregisterProtocol();
    expect(f.request).toHaveBeenCalledWith("protocol_register", {});
    expect(f.request).toHaveBeenCalledWith("protocol_unregister", {});
    const malformed = fixture(() => ({
      registered: true,
      scheme: "arbitrary",
    }));
    await expect(malformed.native.registerProtocol()).rejects.toThrow(
      "PROTOCOL_REGISTRATION_CONFLICT",
    );
  });
  it("launches fixed headless authority with bounded approved public pin only", async () => {
    const f = fixture(() => ({ identity: { ...wire, pid: 43 } }));
    expect((await f.native.launchAccountAuthority(pin)).pid).toBe(43);
    expect(f.request).toHaveBeenCalledWith(
      "account_authority_launch",
      {
        app_sha256: pin.sha256,
        app_bytes: 64,
        publisher_sha256: pin.publisherSha256,
      },
      35000,
    );
    await expect(
      f.native.launchAccountAuthority({ ...pin, bytes: 256 * 1024 ** 2 + 1 }),
    ).rejects.toThrow("BAD_REQUEST");
    await expect(
      f.native.launchAccountAuthority({ ...pin, sha256: "C:\\other.exe" }),
    ).rejects.toThrow("HELPER_INTEGRITY_INVALID");
  });
  it("validates exact native identity for launched process and refuses wrong logon", async () => {
    const f = fixture(() => ({
      identity: { ...wire, pid: 43, session_id: 2 },
    }));
    await expect(f.native.launchAccountAuthority(pin)).rejects.toThrow(
      "PEER_DENIED",
    );
  });
  it("requires real peer/publisher result and excludes foreign SID/session before native request", async () => {
    const f = fixture();
    expect(await f.native.verifyAccountPeer(peer, "browser", pin)).toBe(true);
    expect(f.request).toHaveBeenCalledWith(
      "account_peer_verify",
      expect.objectContaining({ identity: wire, role: "browser" }),
      35000,
    );
    await expect(
      f.native.verifyAccountPeer(
        { ...peer, sid: "S-1-5-21-9-9-9-1002" },
        "browser",
        pin,
      ),
    ).rejects.toThrow("PEER_DENIED");
    expect(
      f.request.mock.calls.filter(([op]) => op === "account_peer_verify"),
    ).toHaveLength(1);
    await expect(
      f.native.verifyAccountPeer(peer, "anything" as "browser", pin),
    ).rejects.toThrow("BAD_REQUEST");
  });
  it("checks authority plus original browser peer through a fixed operation without a caller-supplied app pin", async () => {
    const f = fixture(),
      authority = { ...peer, pid: 44 };
    expect(await f.native.verifyBrowserOwnerProofPeers(authority, peer)).toBe(
      true,
    );
    expect(f.request).toHaveBeenCalledWith(
      "browser_owner_proof_peers",
      { authority: { ...wire, pid: 44 }, browser: wire },
      35000,
    );
    await expect(
      f.native.verifyBrowserOwnerProofPeers(authority, {
        ...peer,
        sessionId: 2,
      }),
    ).rejects.toThrow("PEER_DENIED");
    expect(
      f.request.mock.calls.filter(([op]) => op === "browser_owner_proof_peers"),
    ).toHaveLength(1);
  });
  it("claims only a fixed account ticket nonce and preserves denied claims", async () => {
    const f = fixture(() => ({ claimed: false }));
    expect(await f.native.claimBrowserAccountTicket("c".repeat(64))).toBe(
      false,
    );
    expect(f.request).toHaveBeenCalledWith("claim_browser_account_ticket", {
      nonce: "c".repeat(64),
    });
    await expect(
      f.native.claimBrowserAccountTicket("arbitrary pipe"),
    ).rejects.toThrow("BAD_REQUEST");
  });
  it("binds explicit desktop/chrome owner-kind to the fixed native proof operation", async () => {
    const f = fixture(),
      authority = { ...peer, pid: 44 };
    expect(
      await f.native.verifyPersonalOwnerProofPeers(authority, peer, "desktop"),
    ).toBe(true);
    expect(f.request).toHaveBeenCalledWith(
      "personal_owner_proof_peers",
      { authority: { ...wire, pid: 44 }, owner: wire, owner_kind: "desktop" },
      35000,
    );
    await expect(
      f.native.verifyPersonalOwnerProofPeers(
        authority,
        peer,
        "other" as "desktop",
      ),
    ).rejects.toThrow("PEER_DENIED");
    await expect(
      f.native.verifyPersonalOwnerProofPeers(
        authority,
        { ...peer, sessionId: 2 },
        "chrome",
      ),
    ).rejects.toThrow("PEER_DENIED");
    expect(
      f.request.mock.calls.filter(
        ([op]) => op === "personal_owner_proof_peers",
      ),
    ).toHaveLength(1);
  });
  it("rejects missing native boolean proof instead of optimistic success", async () => {
    const f = fixture(() => ({ verified: "yes", claimed: 1 }));
    await expect(
      f.native.verifyAccountPeer(peer, "authority", pin),
    ).rejects.toThrow("PROTOCOL_MISMATCH");
    await expect(
      f.native.verifyBrowserOwnerProofPeers(peer, peer),
    ).rejects.toThrow("PROTOCOL_MISMATCH");
    await expect(
      f.native.claimBrowserAccountTicket("d".repeat(64)),
    ).rejects.toThrow("PROTOCOL_MISMATCH");
  });
});
