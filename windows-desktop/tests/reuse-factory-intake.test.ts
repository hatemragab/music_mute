import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createWindowsReuse } from "../src/main/reuse/factory.js";
import { LibraryStore } from "../src/main/library/store.js";
import { LibraryArtifactCache } from "../src/main/library/artifacts.js";
import { MemoryLibraryDisk } from "./library-fixtures.js";
import { storageFixture } from "./storage-fixtures.js";
it("passes the actual factory intake policy into the publisher before private pair reads or network requests", async () => {
  const f = await storageFixture(),
    request = vi.fn<typeof fetch>(async () => {
      throw new Error("UNEXPECTED_NETWORK");
    });
  const reuse = createWindowsReuse({
    host: f.host,
    store: new LibraryStore(new MemoryLibraryDisk(), () => true),
    cache: new LibraryArtifactCache(f.host, () => true),
    pins: f.pins,
    tools: {
      snapshotMediaTools: async () => {
        throw new Error("UNEXPECTED_TOOL");
      },
    },
    admission: {
      protectTree: (...args) => f.controller.protectTree(...args),
      reserveVoice: (...args) => f.controller.reserveVoice(...args),
    },
    origin: "https://api.example.test",
    current: () => true,
    consumersAllowed: () => false,
    fetch: request,
  });
  try {
    expect(reuse.publisher).toBeDefined();
    await expect(reuse.publisher!.stage(randomUUID(), true)).rejects.toThrow(
      "CONSUMERS_PAUSED",
    );
    await reuse.publisher!.drain();
    await reuse.publisher!.resume();
    expect(request).not.toHaveBeenCalled();
    expect(f.native.validatePath).not.toHaveBeenCalled();
  } finally {
    await reuse.publisher?.dispose();
    await reuse.controller.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});
