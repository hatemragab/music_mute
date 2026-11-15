import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import { PrivatePersonalStorage } from "../personal/storage.js";
import { ScopedMediaServer } from "../player/media-server.js";
import { LibraryPins } from "../library/pins.js";
import { privateFingerprint } from "../prepare/private-files.js";
import type { BrowserMediaPort } from "./service.js";
import type { ConsumerProcessIdentity } from "../../../../worker/src/platform/windows/consumer-native.js";
/** The extension receives only origin-bound loopback grants for an authorized owned view. */
export async function createBrowserMedia(
  host: HostContext,
  origin: string,
  current: (jobId: string, sha256: string) => Promise<boolean>,
  processIdentity: (pid: number) => Promise<ConsumerProcessIdentity | null>,
): Promise<BrowserMediaPort> {
  await host.directory("library");
  const storage = new PrivatePersonalStorage(host),
    pins = new LibraryPins(host, processIdentity),
    server = new ScopedMediaServer(origin);
  await server.start();
  return {
    issue: async (job) => {
      if (
        job.state !== "ready" ||
        !job.vocals ||
        !(await current(job.id, job.vocals.sha256))
      )
        throw new Error("OWNER_DETACHED");
      const artifact = job.vocals,
        path = await storage.artifactPath(
          job.id,
          artifact.id,
          AbortSignal.timeout(60000),
        ),
        relative = win32.relative(host.personalRoot, path);
      const before = await privateFingerprint(host, relative);
      if (before.bytes !== artifact.bytes) throw new Error("OUTPUT_INVALID");
      const file = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let pin: Awaited<ReturnType<LibraryPins["pin"]>> | undefined;
      try {
        pin = await pins.pin({
          relativePath: relative,
          artifactId: artifact.id,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          mime: artifact.contentType,
          durationSeconds: artifact.durationSeconds,
        });
        const verify = async () => {
          if (!(await current(job.id, artifact.sha256)))
            throw new Error("OWNER_DETACHED");
          if (
            JSON.stringify(await privateFingerprint(host, relative)) !==
            JSON.stringify(before)
          )
            throw new Error("OUTPUT_INVALID");
          const info = await file.stat({ bigint: true });
          if (
            String(info.dev) !== before.device ||
            String(info.ino) !== before.fileId ||
            Number(info.size) !== before.bytes ||
            String(info.mtimeNs) !== before.writtenAt ||
            String(info.ctimeNs) !== before.changedAt
          )
            throw new Error("OUTPUT_INVALID");
        };
        const held = pin;
        return await server.issue(job.ownerId, {
          file,
          bytes: artifact.bytes,
          mime: "audio/mpeg",
          current: verify,
          release: async () => {
            try {
              await file.close();
            } finally {
              await held.release();
            }
          },
        });
      } catch (error) {
        try {
          await file.close();
        } finally {
          await pin?.release();
        }
        throw error;
      }
    },
    close: () => server.close(),
  };
}
