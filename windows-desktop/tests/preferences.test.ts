import { expect, it, vi } from "vitest";
import {
  PreferencesController,
  type PreferencesStore,
} from "../src/main/preferences/controller.js";
import {
  DEFAULT_PREFERENCES,
  parsePreferencesCommand,
  resolvedLanguage,
} from "../src/shared/preferences-contracts.js";
function fixture(initial: Buffer | null = null) {
  let bytes = initial;
  const store: PreferencesStore = {
    read: vi.fn(async () => bytes),
    write: vi.fn(async (value) => {
      bytes = Buffer.from(value);
    }),
    quarantine: vi.fn(async () => {}),
  };
  return {
    controller: new PreferencesController(store, "ar-EG"),
    store,
    bytes: () => bytes,
  };
}
it("resolves language safely and persists only device settings", async () => {
  const f = fixture();
  await f.controller.execute({ type: "RESTORE" });
  expect(f.controller.view().resolvedLanguage).toBe("ar");
  await f.controller.execute({
    type: "SET",
    patch: { appearance: "light", language: "en", volume: 0, muted: true },
  });
  expect(f.controller.view()).toMatchObject({
    state: "ready",
    resolvedLanguage: "en",
    value: { appearance: "light", volume: 0, muted: true },
  });
  expect(JSON.parse(f.bytes()!.toString())).not.toHaveProperty("account");
  expect(resolvedLanguage("system", "fr-FR")).toBe("en");
  await f.controller.close();
});
it("migrates a known earlier partial record without overwriting a future version", async () => {
  const old = fixture(
    Buffer.from(JSON.stringify({ version: 0, language: "ar" })),
  );
  await old.controller.execute({ type: "RESTORE" });
  expect(old.controller.view().value).toEqual({
    ...DEFAULT_PREFERENCES,
    language: "ar",
  });
  expect(old.store.write).toHaveBeenCalledOnce();
  const future = fixture(Buffer.from('{"version":99,"language":"ar"}'));
  await future.controller.execute({ type: "RESTORE" });
  expect(future.controller.view().state).toBe("error");
  expect(future.store.write).not.toHaveBeenCalled();
  await expect(
    future.controller.execute({ type: "SET", patch: { accent: "blue" } }),
  ).rejects.toThrow();
  await future.controller.execute({ type: "RESET", confirmed: true });
  expect(future.store.quarantine).toHaveBeenCalledOnce();
  expect(future.controller.view().state).toBe("ready");
});
it("serializes concurrent edits so one preference cannot replace another", async () => {
  const f = fixture();
  await f.controller.execute({ type: "RESTORE" });
  await Promise.all([
    f.controller.execute({ type: "SET", patch: { accent: "mint" } }),
    f.controller.execute({ type: "SET", patch: { textSize: "large" } }),
  ]);
  expect(f.controller.view().value).toMatchObject({
    accent: "mint",
    textSize: "large",
  });
});
it.each([
  { type: "SET", patch: { id_token: "secret" } },
  { type: "SET", patch: { volume: NaN } },
  { type: "SET", patch: { textSize: "huge" } },
  { type: "RESET", confirmed: false },
  { type: "SET", patch: { lastAudibleVolume: 0 } },
])("rejects unsafe settings %j", (value) => {
  expect(() => parsePreferencesCommand(value)).toThrow();
});
