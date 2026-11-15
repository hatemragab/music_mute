import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SectionStore } from "../src/main/section-store.js";
it("restores the last serialized navigation and tolerates corrupt presentation state", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-section-"));
  const file = join(root, "ui.json");
  try {
    const store = new SectionStore(file);
    expect(await store.read()).toBe("home");
    await Promise.all([store.write("account"), store.write("library")]);
    expect(await new SectionStore(file).read()).toBe("library");
    await writeFile(file, '{"section":"arbitrary"}');
    expect(await store.read()).toBe("home");
    await writeFile(file, "not-json");
    expect(await store.read()).toBe("home");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
