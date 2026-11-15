import { describe, expect, it, vi } from "vitest";
import {
  WindowsConsumerNative,
  parseConsumerInstallerLaunch,
  type ConsumerInstallerPin,
  type ConsumerNativeOperation,
  type ConsumerNativeTransport,
} from "../src/platform/windows/consumer-native.js";

const sid = "S-1-5-21-100-200-300-1001";
const pin: ConsumerInstallerPin = {
  identity: "a".repeat(64),
  sha256: "b".repeat(64),
  bytes: 128,
  publisherSha256: "c".repeat(64),
};
const identity = {
  sid,
  session_id: 1,
  pid: 322,
  creation_time: "133000000000000001",
};
const wirePin = {
  identity: pin.identity,
  sha256: pin.sha256,
  bytes: pin.bytes,
  publisher_sha256: pin.publisherSha256,
};
function status(state = "running") {
  return {
    state,
    certificate: {
      version: 1,
      nonce: "d".repeat(64),
      pin: { ...wirePin },
      monitor: { ...identity },
      process: { ...identity, pid: 323 },
      exit_code: state === "completed" ? 0 : null,
      tree_exited: state === "completed",
    },
  };
}
describe("protected installer launch policy (injected boundary, no installer execution)", () => {
  it("requests completed monitor cleanup using only the fixed approved pin and preserves unconfirmed live cleanup", async () => {
    let response: unknown = { removed: false };
    const request = vi.fn(async () => response),
      native = new WindowsConsumerNative({
        request,
        close: vi.fn(async () => {}),
      });
    expect(await native.removeCompletedInstallerMonitor(pin)).toBe(false);
    expect(request).toHaveBeenCalledWith(
      "installer_monitor_remove_completed",
      wirePin,
      35000,
    );
    response = { removed: true };
    expect(await native.removeCompletedInstallerMonitor(pin)).toBe(true);
    response = { removed: true, path: "anywhere" };
    await expect(native.removeCompletedInstallerMonitor(pin)).rejects.toThrow(
      "PROTOCOL_MISMATCH",
    );
    await expect(
      native.removeCompletedInstallerMonitor({ ...pin, identity: "../escape" }),
    ).rejects.toThrow("BAD_REQUEST");
  });
  it("preserves ambiguous outcome without converting PID absence to completion", () => {
    expect(
      parseConsumerInstallerLaunch(status("unknown"), pin, sid).state,
    ).toBe("unknown");
    expect(
      parseConsumerInstallerLaunch(
        { state: "absent", certificate: null },
        pin,
        sid,
      ),
    ).toEqual({ state: "absent", certificate: null });
    const completed = parseConsumerInstallerLaunch(
      status("completed"),
      pin,
      sid,
    );
    expect(completed.certificate?.treeExited).toBe(true);
    expect(completed.certificate?.exitCode).toBe(0);
  });
  it.each(["launching", "running", "unknown"])(
    "rejects fabricated exit proof in %s",
    (state) => {
      const row = status(state);
      row.certificate.tree_exited = true;
      expect(() => parseConsumerInstallerLaunch(row, pin, sid)).toThrow(
        "PROTOCOL_MISMATCH",
      );
    },
  );
  it("accepts original same-SID logon for inspection while fencing different SID/pin", () => {
    const row = status();
    row.certificate.monitor.session_id = 2;
    row.certificate.process.session_id = 2;
    expect(
      parseConsumerInstallerLaunch(row, pin, sid).certificate?.process
        ?.sessionId,
    ).toBe(2);
    row.certificate.process.sid = "S-1-5-21-100-200-300-1002";
    expect(() => parseConsumerInstallerLaunch(row, pin, sid)).toThrow(
      "PEER_DENIED",
    );
    expect(() =>
      parseConsumerInstallerLaunch(
        status(),
        { ...pin, sha256: "e".repeat(64) },
        sid,
      ),
    ).toThrow("PEER_DENIED");
  });
  it("requires both captured identities and bounded exact completed handle/tree proof", () => {
    for (const exitCode of [-1, 0x1_0000_0000, 0.5, null]) {
      const row = status("completed");
      row.certificate.exit_code = exitCode;
      expect(() => parseConsumerInstallerLaunch(row, pin, sid)).toThrow(
        "PROTOCOL_MISMATCH",
      );
    }
    expect(() =>
      parseConsumerInstallerLaunch(
        {
          ...status("completed"),
          certificate: { ...status("completed").certificate, process: null },
        },
        pin,
        sid,
      ),
    ).toThrow("PROTOCOL_MISMATCH");
    expect(() =>
      parseConsumerInstallerLaunch(
        { ...status(), path: "external.exe" },
        pin,
        sid,
      ),
    ).toThrow("PROTOCOL_MISMATCH");
    expect(() =>
      parseConsumerInstallerLaunch(
        { state: "absent", certificate: status().certificate },
        pin,
        sid,
      ),
    ).toThrow("PROTOCOL_MISMATCH");
  });
  it("inspect/recovery uses only fixed signed pin and never issues a launch retry", async () => {
    const request = vi.fn(async (operation: ConsumerNativeOperation) =>
      operation === "identity"
        ? {
            ...identity,
            logon_sid: "S-1-5-5-100-300",
            native_arch: "x64",
            process_arch: "x64",
            os_major: 10,
            os_build: 19045,
            local_app_data: "C:\\Users\\Fixture\\AppData\\Local",
          }
        : status("unknown"),
    );
    const transport: ConsumerNativeTransport = {
      request,
      close: vi.fn(async () => {}),
    };
    const native = new WindowsConsumerNative(transport);
    expect((await native.inspectInstallerLaunch(pin)).state).toBe("unknown");
    expect((await native.recoverInstallerLaunch(pin)).state).toBe("unknown");
    expect(request).toHaveBeenCalledWith(
      "installer_launch_inspect",
      wirePin,
      35000,
    );
    expect(request).toHaveBeenCalledWith(
      "installer_launch_recover",
      wirePin,
      35000,
    );
    expect(
      request.mock.calls.some(
        ([operation]) => operation === "installer_launch",
      ),
    ).toBe(false);
    await expect(
      native.inspectInstallerLaunch({ ...pin, identity: "..\\elsewhere" }),
    ).rejects.toThrow("BAD_REQUEST");
  });
});
