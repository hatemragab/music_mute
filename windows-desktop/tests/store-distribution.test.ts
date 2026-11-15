import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("../src/main/browser/store-native.js", () => ({
  StoreNativeAuthority: class {
    #live = true;
    creatorProof() {
      if (!this.#live) throw new Error("FIXTURE_CLOSED");
    }
    inspectWorker() {
      this.creatorProof();
      return fixture.inspect();
    }
    close() {
      this.#live = false;
    }
  },
}));
import { StoreNativeAuthority } from "../src/main/browser/store-native.js";
import {
  storeUpdateDestination,
  STORE_UPDATE_VIEW,
} from "../src/main/update/store-distribution.js";
import { parseConsumerUpdateCommand } from "../src/shared/update-contracts.js";
const request_id = "a1234567-1234-4123-8123-123456789abc";
const command = (product: string) => ({
  version: 1,
  request_id,
  action: "store_open",
  product,
});
it("returns only reserved fixed HTTPS product destinations after actual authority revalidation (receiving fixture)", async () => {
  const authority = new (
    StoreNativeAuthority as unknown as { new (): StoreNativeAuthority }
  )();
  expect(await storeUpdateDestination(authority, command("gui"))).toBe(
    "https://apps.microsoft.com/detail/9P7VX8JK8B68",
  );
  expect(await storeUpdateDestination(authority, command("worker"))).toBe(
    "https://apps.microsoft.com/detail/9P4GXB0NRJDG",
  );
  expect(fixture.inspect).toHaveBeenCalledTimes(2);
  expect(STORE_UPDATE_VIEW).toMatchObject({
    phase: "idle",
    available: null,
    automaticDiscovery: false,
  });
  await authority.close();
  await expect(
    storeUpdateDestination(authority, command("gui")),
  ).rejects.toThrow();
  await expect(
    storeUpdateDestination({} as StoreNativeAuthority, command("gui")),
  ).rejects.toThrow();
});
it("denies arbitrary destinations, extra fields and every executable updater action", async () => {
  const authority = new (
    StoreNativeAuthority as unknown as { new (): StoreNativeAuthority }
  )();
  for (const input of [
    command("https://evil.invalid"),
    { ...command("gui"), url: "https://evil.invalid" },
    { ...command("gui"), product: "runtime" },
    { version: 1, request_id, action: "install" },
    { version: 1, request_id, action: "check" },
    { version: 1, request_id, action: "recover" },
    { version: 1, request_id, action: "automatic_discovery", enabled: true },
  ])
    await expect(storeUpdateDestination(authority, input)).rejects.toThrow();
  expect(parseConsumerUpdateCommand(command("gui"))).toEqual(command("gui"));
});
