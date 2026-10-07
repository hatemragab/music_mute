import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadConfirmedUnpairReceipt,
  writeConfirmedUnpairReceipt,
} from "../src/platform/shared/unpair-receipt.js";

const roots: string[] = [];
const machineId = "32410a14-e85a-4a1d-bb99-61fa54b07eaa";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// These fixtures exercise Darwin paths, UID ownership and POSIX permissions.
describe.skipIf(process.platform !== "darwin")(
  "backend-confirmed macOS unpair receipt",
  () => {
    it("writes and reads an owner-only atomic confirmation", async () => {
      const root = await privateRoot();
      const path = join(root, "state", "unpaired.json");
      await expect(
        writeConfirmedUnpairReceipt(
          path,
          machineId,
          new Date("2026-09-21T03:00:00.000Z"),
        ),
      ).resolves.toEqual({
        schemaVersion: 1,
        machineId,
        confirmedAt: "2026-09-21T03:00:00.000Z",
      });
      await expect(loadConfirmedUnpairReceipt(path)).resolves.toMatchObject({
        machineId,
      });
    });

    it("rejects a writable, malformed, or forged confirmation", async () => {
      const root = await privateRoot();
      const path = join(root, "unpaired.json");
      await writeFile(path, "{}\n", { mode: 0o600 });
      await expect(loadConfirmedUnpairReceipt(path)).rejects.toThrow("invalid");
      await writeFile(
        path,
        `${JSON.stringify({
          schemaVersion: 1,
          machineId,
          confirmedAt: "2026-09-21T03:00:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );
      await chmod(path, 0o666);
      await expect(loadConfirmedUnpairReceipt(path)).rejects.toThrow("unsafe");
    });
    it("persists deletion only from an explicit confirmed response", async () => {
      const root = await privateRoot();
      const path = join(root, "unpaired.json");
      await writeConfirmedUnpairReceipt(path, machineId, new Date(), true);
      await expect(loadConfirmedUnpairReceipt(path)).resolves.toMatchObject({
        deleted: true,
      });
      const receipt = await loadConfirmedUnpairReceipt(path);
      await writeFile(path, JSON.stringify({ ...receipt, deleted: false }), {
        mode: 0o600,
      });
      await expect(loadConfirmedUnpairReceipt(path)).rejects.toThrow("invalid");
    });
  },
);

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-unpair-receipt-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
