import { describe, expect, it } from "vitest";
import { WindowsStorageFiles } from "../src/main/storage/files.js";
import type { HostContext } from "../src/main/host-context.js";
import type { StorageItem } from "../src/main/storage/model.js";
describe("storage cleanup fixed namespaces", () => {
  it.each([
    "models\\Kim_Vocal_2.onnx",
    "runtime\\releases\\abc",
    "personal\\exports\\saved.mp3",
    "..\\source.wav",
    "credentials\\secret.json",
  ])(
    "never accepts an eligiblelabel for protectedroot %s",
    async (relativePath) => {
      const file = new WindowsStorageFiles({} as HostContext),
        item: StorageItem = {
          id: "malformed",
          relativePath,
          category: "voices",
          bytes: 1,
          lastUsed: 0,
          eligible: true,
          files: [],
          directories: [],
        };
      await expect(
        file.removeOwned(item, new AbortController().signal),
      ).rejects.toThrow();
    },
  );
});
