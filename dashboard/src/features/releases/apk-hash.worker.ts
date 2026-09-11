/// <reference lib="webworker" />

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

self.onmessage = async (
  event: MessageEvent<{ file: File; chunkBytes: number }>,
) => {
  try {
    const { file, chunkBytes } = event.data;
    const digest = sha256.create();
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      const chunk = new Uint8Array(
        await file.slice(offset, offset + chunkBytes).arrayBuffer(),
      );
      digest.update(chunk);
      self.postMessage({
        type: "progress",
        loaded: Math.min(offset + chunk.length, file.size),
        total: file.size,
      });
    }
    self.postMessage({
      type: "complete",
      sha256Hex: bytesToHex(digest.digest()),
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Hashing failed.",
    });
  }
};
