import { expect, it, vi } from "vitest";
import {
  WindowsConsumerNative,
  parseStoreModelPublication,
} from "../src/platform/windows/consumer-native.js";
import type {
  ConsumerNativeOperation,
  ConsumerNativeTransport,
} from "../src/platform/windows/consumer-native-transport.js";

const token = "a".repeat(64),
  bytes = 66759214,
  sha256 = "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
  birth = { device: "7", file_id: "9", born_at: "132000000000000001" };
function publication() {
  return {
    version: 1,
    state: "published",
    identity: {
      ...birth,
      bytes,
      written_at: "132000000000000002",
      changed_at: "132000000000000003",
    },
    bytes,
    sha256,
    backup_relative_path: `models\\Kim_Vocal_2.onnx.previous-${"b".repeat(64)}`,
  };
}
function fixture(reply = publication()) {
  const request = vi.fn(
    async (
      operation: ConsumerNativeOperation,
      _args: Record<string, unknown>,
    ) => {
      if (operation === "store_model_file_open")
        return {
          state: "opened",
          token,
          identity: { ...publication().identity, bytes: 0 },
        };
      if (
        operation === "store_model_publish" ||
        operation === "store_model_recover"
      )
        return reply;
      if (operation === "private_file_close") return { closed: true };
      throw new Error("unrequested fixture operation");
    },
  );
  const close = vi.fn(async () => {}),
    transport: ConsumerNativeTransport = { request, close };
  return { request, close, native: new WindowsConsumerNative(transport) };
}

it("uses fixed Store model commands and retains the original token privately (receiving fixture, no Store authority)", async () => {
  const f = fixture(),
    file = await f.native.openStoreModelFile();
  expect(f.request).toHaveBeenNthCalledWith(1, "store_model_file_open", {
    mode: "create-new",
    expected_birth: null,
  });
  expect(file).not.toHaveProperty("token");
  const result = await file.publish();
  expect(result).toMatchObject({
    version: 1,
    state: "published",
    bytes,
    sha256,
  });
  expect(f.request).toHaveBeenNthCalledWith(2, "store_model_publish", {
    token,
  });
  for (const operation of [
    () => file.writeFile("caller"),
    () => file.truncate(0),
    () => file.sync(),
  ])
    expect(operation).toThrow("BAD_REQUEST");
  await file.close();
  expect(f.request).toHaveBeenNthCalledWith(3, "private_file_close", { token });
});

it("recovers only exact fixed publication observations and preserves native failure", async () => {
  const f = fixture();
  expect(await f.native.recoverStoreModelPublication()).toEqual(
    parseStoreModelPublication(publication()),
  );
  expect(f.request).toHaveBeenCalledWith("store_model_recover", {});
  const failure = new Error("original publication still pending");
  f.request.mockRejectedValueOnce(failure);
  await expect(f.native.recoverStoreModelPublication()).rejects.toBe(failure);
});

it("does not accept caller-selected bytes, hash, path, generation, state or extra proof fields", () => {
  const valid = publication();
  for (const bad of [
    { ...valid, bytes: bytes - 1 },
    { ...valid, sha256: "c".repeat(64) },
    { ...valid, state: "ready" },
    { ...valid, version: 2 },
    { ...valid, signature_kind: 3 },
    { ...valid, backup_relative_path: "models\\..\\other.onnx" },
    {
      ...valid,
      backup_relative_path: `models\\Kim_Vocal_2.onnx.previous-${"B".repeat(64)}`,
    },
    { ...valid, identity: { ...valid.identity, bytes: 0 } },
    { ...valid, identity: { ...valid.identity, file_id: "0" } },
  ])
    expect(() => parseStoreModelPublication(bad)).toThrow("PROTOCOL_MISMATCH");
});

it("poisons a publication response naming a substituted generation and still closes only the original capability", async () => {
  const altered = publication();
  altered.identity.file_id = "10";
  const f = fixture(altered),
    file = await f.native.openStoreModelFile();
  await expect(file.publish()).rejects.toThrow("PROTOCOL_MISMATCH");
  await expect(file.info()).rejects.toThrow("HELPER_UNAVAILABLE");
  await file.close();
  expect(f.request).toHaveBeenLastCalledWith("private_file_close", { token });
});

it("seals later writes before a publication reply arrives and never retries a failed publish", async () => {
  const f = fixture(),
    file = await f.native.openStoreModelFile();
  let reject!: (error: unknown) => void;
  f.request.mockImplementationOnce(
    async () =>
      new Promise((_, no) => {
        reject = no;
      }),
  );
  const pending = file.publish();
  expect(() => file.writeFile("racing write")).toThrow("BAD_REQUEST");
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  const failure = new Error("lost publication acknowledgment");
  reject(failure);
  await expect(pending).rejects.toBe(failure);
  await expect(file.publish()).rejects.toThrow("HELPER_UNAVAILABLE");
  expect(
    f.request.mock.calls.filter(([name]) => name === "store_model_publish"),
  ).toHaveLength(1);
  await file.close();
});
