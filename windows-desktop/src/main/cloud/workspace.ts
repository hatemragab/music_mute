import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { win32 } from "node:path";
import type { ConsumerOwnedProcess } from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import {
  isStoreCpuOwner,
  assertStoreCpuOwnerHost,
  storeCpuOwnerRetired,
  type StoreCpuOwner,
} from "../session/store-cpu-owner.js";
import {
  storageBirth,
  type StorageWriteLease,
  type StorageBirth,
} from "../storage/write-journal.js";
import type { ScratchReservationLease } from "../storage/scratch-reservations.js";
export interface CloudScratchAdmission {
  beginWrite(relative: string, kind: "tree"): Promise<StorageWriteLease>;
  protectTree(
    relative: string,
    purpose: "download",
  ): Promise<{ release(): Promise<void> }>;
  trackWorkspace(
    relative: string,
    owner: ConsumerOwnedProcess | StoreCpuOwner,
    purpose: "processing",
  ): Promise<{ release(): Promise<void>; retireForRelaunch(): Promise<void> }>;
  reserveScratch(
    bytes: number,
    relative: string,
  ): Promise<ScratchReservationLease>;
}
/** One bounded Node copier hands its exact private directory to a Native Job before any tool launch. */
export class CloudScratchWorkspace {
  private birth: StorageBirth | undefined;
  private writer: StorageWriteLease | undefined;
  private reservation: ScratchReservationLease | undefined;
  private pin: { release(): Promise<void> } | undefined;
  private workspacePins: {
    release(): Promise<void>;
    retireForRelaunch(): Promise<void>;
  }[] = [];
  private handedOff = false;
  private closed = false;
  private unsafe = false;
  private owner: ConsumerOwnedProcess | StoreCpuOwner | undefined;
  private closing: Promise<void> | undefined;
  private constructor(
    private readonly host: HostContext,
    private readonly admission: CloudScratchAdmission,
    readonly relativePath: string,
  ) {}
  static async create(
    host: HostContext,
    admission: CloudScratchAdmission,
    relativePath: string,
    bytes: number,
  ) {
    const workspace = new CloudScratchWorkspace(host, admission, relativePath);
    try {
      if (
        !admission?.beginWrite ||
        !admission.protectTree ||
        !admission.trackWorkspace ||
        !admission.reserveScratch
      )
        throw new Error("STORAGE_NOT_READY");
      await host.directory("cloud\\work");
      workspace.reservation = await admission.reserveScratch(
        bytes,
        relativePath,
      );
      workspace.writer = await admission.beginWrite(relativePath, "tree");
      await host.directory(relativePath);
      workspace.birth = storageBirth(
        await lstat(win32.join(host.personalRoot, relativePath), {
          bigint: true,
        }),
      );
      await workspace.writer.captureCreated(workspace.birth);
      workspace.pin = await admission.protectTree(relativePath, "download");
      return workspace;
    } catch (error) {
      await workspace.close().catch(() => {});
      throw error;
    }
  }
  markUnsafe(): void {
    this.unsafe = true;
  }
  async beforeLaunch(): Promise<void> {
    if (this.closed || this.unsafe) throw new Error("STORAGE_RECOVERY_PENDING");
    await this.reservation!.handoff();
    // A prior decoder's exit certificate cannot authorize a new launch ACK gap.
    this.owner = undefined;
    for (const prior of this.workspacePins) await prior.retireForRelaunch();
    this.workspacePins = [];
    if (!this.handedOff) {
      await this.writer!.handoff();
      this.handedOff = true;
    }
  }
  async onOwner(owner: ConsumerOwnedProcess | StoreCpuOwner): Promise<void> {
    if (isStoreCpuOwner(owner)) assertStoreCpuOwnerHost(owner, this.host);
    this.owner = isStoreCpuOwner(owner) ? owner : structuredClone(owner);
    await this.reservation!.bind(owner);
    this.workspacePins.push(
      await this.admission.trackWorkspace(
        this.relativePath,
        owner,
        "processing",
      ),
    );
  }
  close(): Promise<void> {
    this.closing ??= this.closeOperation().finally(() => {
      if (!this.closed) this.closing = undefined;
    });
    return this.closing;
  }
  private async closeOperation(): Promise<void> {
    if (this.closed) return;
    if (this.unsafe) {
      try {
        if (
          !this.owner ||
          !(isStoreCpuOwner(this.owner)
            ? await storeCpuOwnerRetired(this.owner)
            : this.host.native.ownedTreeExited &&
              (await this.host.native.ownedTreeExited(this.owner)))
        )
          throw new Error("STORAGE_RECOVERY_PENDING");
      } catch {
        throw new Error("STORAGE_RECOVERY_PENDING");
      }
      this.unsafe = false;
    }
    let failure: unknown;
    if (!this.unsafe && this.birth) {
      try {
        await this.host.native.validatePath(
          "personal",
          this.relativePath,
          "directory",
        );
        if (
          JSON.stringify(
            storageBirth(
              await lstat(
                win32.join(this.host.personalRoot, this.relativePath),
                { bigint: true },
              ),
            ),
          ) !== JSON.stringify(this.birth)
        )
          throw new Error("STORAGE_WORKSPACE_CHANGED");
        let budget = 128;
        const remove = async (
          relative: string,
          depth: number,
        ): Promise<void> => {
          if (--budget < 0 || depth > 4)
            throw new Error("STORAGE_WORKSPACE_CHANGED");
          const stat = await lstat(
            win32.join(this.host.personalRoot, relative),
          );
          if (stat.isSymbolicLink()) throw new Error("PATH_UNSAFE");
          if (stat.isDirectory()) {
            await this.host.native.validatePath(
              "personal",
              relative,
              "directory",
            );
            for (const name of await readdir(
              win32.join(this.host.personalRoot, relative),
            )) {
              if (/[\\/:\p{Cc}]/u.test(name)) throw new Error("PATH_UNSAFE");
              await remove(`${relative}\\${name}`, depth + 1);
            }
            await this.host.native.validatePath(
              "personal",
              relative,
              "directory",
            );
            await rmdir(win32.join(this.host.personalRoot, relative));
          } else {
            if (!stat.isFile() || stat.nlink !== 1)
              throw new Error("PATH_UNSAFE");
            await this.host.native.validatePath("personal", relative, "file");
            await unlink(win32.join(this.host.personalRoot, relative));
          }
        };
        await remove(this.relativePath, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure = error;
      }
    }
    try {
      await this.writer?.settle();
    } catch (error) {
      failure ??= error;
    }
    if (!this.unsafe && !failure) {
      try {
        await this.reservation?.release();
      } catch (error) {
        failure ??= error;
      }
    }
    if (!failure) {
      const releases = await Promise.allSettled(
        this.workspacePins.map((pin) => pin.release()),
      );
      failure = releases.find((result) => result.status === "rejected")?.reason;
      try {
        await this.pin?.release();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
    this.closed = true;
  }
}
