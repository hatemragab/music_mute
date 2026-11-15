import {
  consumerInstallerArgs,
  type ConsumerInstallerPin,
  type ConsumerInstallerLaunchStatus,
  type WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { ConsumerUpdateMetadata } from "../../shared/update-contracts.js";
import { consumerUpdateIdentity } from "./metadata.js";

export interface ConsumerInstallerAttempt {
  version: 3;
  pin: ConsumerInstallerPin;
  app: { version: string; sha256: string };
  phase: "launching" | "running" | "completed";
  nonce: string | null;
}
type Vault = Pick<WindowsConsumerNative, "vaultRead" | "vaultWrite">;
type Native = Pick<
  WindowsConsumerNative,
  | "verifyInstaller"
  | "launchInstaller"
  | "inspectInstallerLaunch"
  | "recoverInstallerLaunch"
  | "removeCompletedInstallerMonitor"
>;
export function consumerInstallerPin(
  metadata: ConsumerUpdateMetadata,
): ConsumerInstallerPin {
  return {
    identity: consumerUpdateIdentity(metadata),
    sha256: metadata.app.artifact.sha256,
    bytes: metadata.app.artifact.bytes,
    publisherSha256: metadata.publisherSha256,
  };
}
/** Native owns the crash-safe monitor/certificate. The app WAL never infers success from a vanished PID. */
export class ConsumerInstallerCoordinator {
  constructor(
    private readonly vault: Vault,
    private readonly native: Native,
  ) {}
  private async read(): Promise<ConsumerInstallerAttempt | null> {
    const bytes = await this.vault.vaultRead(
      "account",
      "consumer_update_installer",
    );
    if (!bytes) return null;
    try {
      if (bytes.length > 4096) throw new Error();
      const row = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as ConsumerInstallerAttempt;
      if (
        !row ||
        Object.keys(row).sort().join() !== "app,nonce,phase,pin,version" ||
        row.version !== 3 ||
        !["launching", "running", "completed"].includes(row.phase) ||
        !row.app ||
        Object.keys(row.app).sort().join() !== "sha256,version" ||
        !/^[0-9][A-Za-z0-9.-]{0,63}$/u.test(row.app.version) ||
        !/^[a-f0-9]{64}$/u.test(row.app.sha256) ||
        (row.nonce !== null && !/^[a-f0-9]{64}$/u.test(row.nonce))
      )
        throw new Error();
      if (
        !row.pin ||
        Object.keys(row.pin).sort().join() !==
          "bytes,identity,publisherSha256,sha256"
      )
        throw new Error();
      consumerInstallerArgs(row.pin);
      return row;
    } catch {
      throw new Error("UPDATE_INSTALLER_UNCONFIRMED");
    } finally {
      bytes.fill(0);
    }
  }
  async readAttempt(): Promise<ConsumerInstallerAttempt | null> {
    const row = await this.read();
    return row ? structuredClone(row) : null;
  }
  private async write(row: ConsumerInstallerAttempt): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(row));
    try {
      await this.vault.vaultWrite(
        "account",
        "consumer_update_installer",
        bytes,
      );
    } finally {
      bytes.fill(0);
    }
  }
  private async recover(
    row: ConsumerInstallerAttempt,
  ): Promise<ConsumerInstallerLaunchStatus> {
    let status: ConsumerInstallerLaunchStatus;
    try {
      status = await this.native.recoverInstallerLaunch(row.pin);
    } catch {
      throw new Error("UPDATE_INSTALLER_UNCONFIRMED");
    }
    if (status.state === "absent" || status.state === "unknown")
      throw new Error("UPDATE_INSTALLER_UNCONFIRMED");
    if (row.nonce !== null && row.nonce !== status.certificate.nonce)
      throw new Error("UPDATE_INSTALLER_UNCONFIRMED");
    row.nonce = status.certificate.nonce;
    row.phase = status.state === "completed" ? "completed" : status.state;
    await this.write(row);
    return status;
  }
  async launch(metadata: ConsumerUpdateMetadata): Promise<void> {
    const pin = consumerInstallerPin(metadata);
    await this.native.verifyInstaller(pin);
    let row = await this.read();
    if (row && row.pin.identity !== pin.identity) {
      const prior = await this.recover(row);
      if (prior.state !== "completed")
        throw new Error("UPDATE_INSTALLER_RUNNING");
      if (!(await this.native.removeCompletedInstallerMonitor(row.pin)))
        throw new Error("UPDATE_INSTALLER_RUNNING");
      row = null;
    }
    if (row) {
      if (
        JSON.stringify(row.pin) !== JSON.stringify(pin) ||
        row.app.version !== metadata.app.version ||
        row.app.sha256 !== metadata.app.payloadSha256
      )
        throw new Error("UPDATE_INSTALLER_UNCONFIRMED");
      const status = await this.recover(row);
      if (status.state === "completed") {
        if (status.certificate.exitCode !== 0)
          throw new Error("UPDATE_INSTALLER_FAILED");
        return;
      }
      throw new Error(
        status.state === "running"
          ? "UPDATE_INSTALLER_RUNNING"
          : "UPDATE_INSTALLER_UNCONFIRMED",
      );
    }
    row = {
      version: 3,
      pin,
      app: {
        version: metadata.app.version,
        sha256: metadata.app.payloadSha256,
      },
      phase: "launching",
      nonce: null,
    };
    let before: ConsumerInstallerLaunchStatus;
    try {
      before = await this.native.inspectInstallerLaunch(pin);
    } catch {
      throw new Error("UPDATE_INSTALLER_UNCONFIRMED");
    }
    await this.write(row);
    // A lost ACK can be adopted only from the native certificate for this exact pin.
    if (before.state === "absent") {
      try {
        await this.native.launchInstaller(pin);
      } catch {
        /* Inspect the durable native authority below. */
      }
    }
    const status = await this.recover(row);
    if (status.state === "completed") {
      if (status.certificate.exitCode !== 0)
        throw new Error("UPDATE_INSTALLER_FAILED");
    } else if (status.state !== "running")
      throw new Error("UPDATE_INSTALLER_UNCONFIRMED");
  }
  async assertCompleted(metadata: ConsumerUpdateMetadata): Promise<void> {
    const row = await this.read();
    if (!row || row.pin.identity !== consumerUpdateIdentity(metadata)) return;
    const status = await this.recover(row);
    if (status.state !== "completed")
      throw new Error("UPDATE_INSTALLER_RUNNING");
    if (status.certificate.exitCode !== 0 || !status.certificate.treeExited)
      throw new Error("UPDATE_INSTALLER_FAILED");
    if (!(await this.native.removeCompletedInstallerMonitor(row.pin)))
      throw new Error("UPDATE_INSTALLER_RUNNING");
  }
  async assertCurrentApp(app: {
    version: string;
    sha256: string;
  }): Promise<void> {
    const row = await this.read();
    if (
      !row ||
      row.app.version !== app.version ||
      row.app.sha256 !== app.sha256
    )
      return;
    const status = await this.recover(row);
    if (status.state !== "completed")
      throw new Error("UPDATE_INSTALLER_RUNNING");
    if (status.certificate.exitCode !== 0 || !status.certificate.treeExited)
      throw new Error("UPDATE_INSTALLER_FAILED");
    if (!(await this.native.removeCompletedInstallerMonitor(row.pin)))
      throw new Error("UPDATE_INSTALLER_RUNNING");
  }
}
