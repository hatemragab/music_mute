import type { HostContext } from "../host-context.js";
import type { StorageItem } from "./model.js";
import { assertConsumerRelativePath } from "../../../../worker/src/platform/windows/consumer-native-policy.js";
export class WindowsStorageFiles {
  constructor(private readonly host: HostContext) {}
  /** Caller owns the cache mutex and rechecked all consumer pins. No recursive force-delete is used. */
  async removeOwned(
    item: StorageItem,
    signal: AbortSignal,
  ): Promise<{ removedBytes: number; complete: boolean }> {
    if (
      !item.eligible ||
      !["voices", "originals", "thumbnails", "scratch"].includes(item.category)
    )
      throw new Error("STORAGE_ITEM_PROTECTED");
    assertConsumerRelativePath(item.relativePath);
    const personalVoice = /^personal\\results\\[a-f0-9-]{36}\\vocals\.mp3$/u,
      personalOriginal =
        /^personal\\results\\[a-f0-9-]{36}\\original\.(?:mp3|m4a|mp4|webm|opus|ogg|aac|wav|flac)$/u,
      account = new RegExp(
        `^library\\\\media\\\\[a-f0-9]{64}\\\\[a-f0-9]{24}\\\\${item.category === "voices" ? "voice" : "original"}\\\\[a-f0-9]{64}$`,
        "u",
      ),
      thumbnail = /^library\\thumbnails\\[a-f0-9]{64}\.image$/u,
      scratch =
        /^(?:(?:personal\\(?:jobs|inputs|engine-session)|cloud\\work|prepare\\(?:work|downloads))\\[a-f0-9-]{36}|personal\\results\\[a-f0-9-]{36}\.pending)$/u,
      writeFile =
        /^library\\media\\[a-f0-9]{64}\\[a-f0-9]{24}\\(?:voice|original)\\[a-f0-9]{64}\\(?:media\.(?:mp3|m4a|mp4|webm|opus|ogg|aac|wav|flac)(?:\.[a-f0-9-]{36}\.part)?|media\.json\.[a-f0-9-]{36}\.tmp)$/u;
    const fileUnit =
      item.category === "voices"
        ? personalVoice.test(item.relativePath)
        : item.category === "originals"
          ? personalOriginal.test(item.relativePath)
          : item.category === "thumbnails"
            ? thumbnail.test(item.relativePath)
            : item.category === "scratch" && writeFile.test(item.relativePath);
    const treeUnit =
      item.category === "voices" || item.category === "originals"
        ? account.test(item.relativePath)
        : item.category === "scratch"
          ? scratch.test(item.relativePath)
          : false;
    if (
      (!fileUnit && !treeUnit) ||
      item.files.some((file) =>
        fileUnit
          ? file.relativePath !== item.relativePath
          : !file.relativePath.startsWith(`${item.relativePath}\\`),
      ) ||
      item.directories.some(
        (relative) =>
          relative !== item.relativePath &&
          !relative.startsWith(`${item.relativePath}\\`),
      )
    )
      throw new Error("STORAGE_ITEM_PROTECTED");
    let removedBytes = 0,
      complete = true;
    for (const file of item.files) {
      signal.throwIfAborted();
      try {
        const birth = item.births?.[file.relativePath];
        if (!birth) throw new Error("STORAGE_ITEM_CHANGED");
        const candidate = await this.host.native.beginCacheDeletion(
          file.relativePath,
          "file",
          { ...birth, ...file.fingerprint },
        );
        if (!candidate) {
          complete = false;
          break;
        }
        signal.throwIfAborted();
        if (
          (await this.host.native.commitCacheDeletion(candidate)) !==
          "completed"
        ) {
          complete = false;
          break;
        }
        await this.host.native.releaseCacheDeletion(candidate);
        removedBytes += file.fingerprint.bytes;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "PATH_UNSAFE") throw new Error("STORAGE_ITEM_CHANGED");
        if (code === "ENOENT") continue;
        if (["EBUSY", "EPERM", "EACCES"].includes(code ?? "")) {
          complete = false;
          break;
        }
        throw error;
      }
    }
    if (complete)
      for (const relative of [...item.directories].sort(
        (a, b) => b.length - a.length,
      )) {
        try {
          signal.throwIfAborted();
          const birth = item.births?.[relative];
          if (!birth) throw new Error("STORAGE_ITEM_CHANGED");
          const candidate = await this.host.native.beginCacheDeletion(
            relative,
            "directory",
            birth,
          );
          if (
            !candidate ||
            (await this.host.native.commitCacheDeletion(candidate)) !==
              "completed"
          ) {
            complete = false;
            break;
          }
          await this.host.native.releaseCacheDeletion(candidate);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "PATH_UNSAFE") throw new Error("STORAGE_ITEM_CHANGED");
          if (code === "ENOENT") continue;
          if (["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(code ?? "")) {
            complete = false;
            break;
          }
          throw error;
        }
      }
    return { removedBytes, complete };
  }
}
