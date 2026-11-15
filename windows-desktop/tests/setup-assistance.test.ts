import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { packageFile } from "../packaging/validate-assets.js";
import { createWindowsSetupAssistance } from "../src/main/setup-assistance/factory.js";
import { parseSetupAssistanceCommand } from "../src/shared/setup-assistance-contracts.js";
import type { HostContext } from "../src/main/host-context.js";
const { stageSharedExtension } = (await import(
  new URL("../packaging/shared-extension.mjs", import.meta.url).href
)) as {
  stageSharedExtension(
    path: string,
    read: typeof packageFile,
  ): Promise<unknown>;
};
const roots: string[] = [];
const controllers: ReturnType<typeof createWindowsSetupAssistance>[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((c) => c.dispose()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-setup-assistance-"));
  roots.push(root);
  const resources = join(root, "resources"),
    personal = join(root, "personal");
  await mkdir(join(resources, "extension"), { recursive: true });
  await mkdir(join(personal, "models"), { recursive: true });
  await stageSharedExtension(join(resources, "extension"), packageFile);
  const cause: { value: unknown } = { value: null },
    validate = vi.fn(async () => {}),
    os = {
      openChromeExtensions: vi.fn(async () => {}),
      reveal: vi.fn(async (_path: string) => {}),
      copy: vi.fn(async (_text: string) => {}),
    };
  const host = {
    personalRoot: personal,
    native: { validatePath: validate },
  } as unknown as Pick<HostContext, "personalRoot" | "native">;
  const controller = createWindowsSetupAssistance({
    resourcesRoot: resources,
    host,
    modelCause: () => cause.value,
    os,
  });
  controllers.push(controller);
  return {
    root,
    resources,
    personal,
    cause,
    validate,
    os,
    controller,
    signal: new AbortController().signal,
  };
}
it("uses only the complete sealed source payload for user-selected reveal/copy and exposes no paths in its view", async () => {
  const f = await fixture();
  await f.controller.refresh(f.signal);
  expect(f.controller.snapshot()).toMatchObject({
    state: "ready",
    extension: "available",
    chrome: "available",
    modelFolder: "unavailable",
    busy: false,
  });
  await f.controller.execute({ type: "COPY_EXTENSION_PATH" }, f.signal);
  await f.controller.execute({ type: "REVEAL_EXTENSION" }, f.signal);
  await f.controller.execute({ type: "OPEN_CHROME_EXTENSIONS" }, f.signal);
  expect(f.os.copy).toHaveBeenCalledWith(join(f.resources, "extension"));
  expect(f.os.reveal).toHaveBeenCalledWith(join(f.resources, "extension"));
  expect(f.os.openChromeExtensions).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.controller.snapshot())).not.toContain(f.root);
  await writeFile(
    join(f.resources, "extension", "background.js"),
    "altered script",
  );
  await expect(
    f.controller.execute({ type: "COPY_EXTENSION_PATH" }, f.signal),
  ).rejects.toThrow("SETUP_ASSISTANCE_UNAVAILABLE");
  expect(f.os.copy).toHaveBeenCalledTimes(1);
});
it("model-folder assistance requires the actual model component cause, never a generic integrity code or guessed stage", async () => {
  const f = await fixture();
  f.cause.value = { errorCode: "INTEGRITY_INVALID", stage: "model" };
  await f.controller.refresh(f.signal);
  expect(f.controller.snapshot().modelFolder).toBe("unavailable");
  await expect(
    f.controller.execute({ type: "REVEAL_MODEL" }, f.signal),
  ).rejects.toThrow("SETUP_ASSISTANCE_UNAVAILABLE");
  expect(f.os.reveal).not.toHaveBeenCalled();
  f.cause.value = "model";
  await f.controller.refresh(f.signal);
  await f.controller.execute({ type: "REVEAL_MODEL" }, f.signal);
  expect(f.validate).toHaveBeenCalledWith("personal", "models", "directory");
  expect(f.os.reveal).toHaveBeenCalledWith(join(f.personal, "models"));
  f.cause.value = null;
  await f.controller.refresh(f.signal);
  expect(f.controller.snapshot().modelFolder).toBe("unavailable");
});
it.each(["owner", "cause"] as const)(
  "a changed %s during trusted model validation cannot reveal a later context",
  async (change) => {
    const f = await fixture(),
      held = deferred<void>(),
      entered = deferred<void>();
    f.cause.value = "model";
    let current = true;
    f.validate.mockImplementationOnce(async () => {
      entered.resolve();
      await held.promise;
    });
    const work = f.controller.execute(
        { type: "REVEAL_MODEL" },
        f.signal,
        () => current,
      ),
      failure = expect(work).rejects.toThrow("SETUP_ASSISTANCE_UNAVAILABLE");
    await entered.promise;
    if (change === "owner") current = false;
    else f.cause.value = null;
    expect(f.controller.snapshot().busy).toBe(true);
    held.resolve();
    await failure;
    expect(f.os.reveal).not.toHaveBeenCalled();
  },
);
it("disposal cancels intake but retains actual admitted OS completion and bounded fixed failure", async () => {
  const f = await fixture(),
    held = deferred<void>(),
    entered = deferred<void>();
  f.os.copy.mockImplementationOnce(async () => {
    entered.resolve();
    await held.promise;
    throw new Error("UPPERCASE_PRIVATE_SECRET");
  });
  const work = f.controller.execute({ type: "COPY_EXTENSION_PATH" }, f.signal),
    failure = expect(work).rejects.toThrow("SETUP_ASSISTANCE_UNAVAILABLE");
  await entered.promise;
  let closed = false;
  const disposal = f.controller.dispose().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(f.controller.snapshot().busy).toBe(true);
  await expect(
    f.controller.execute({ type: "OPEN_CHROME_EXTENSIONS" }, f.signal),
  ).rejects.toThrow("SETUP_ASSISTANCE_UNAVAILABLE");
  held.resolve();
  await failure;
  await disposal;
  expect(f.controller.snapshot().busy).toBe(false);
  expect(JSON.stringify(f.controller.snapshot())).not.toContain("SECRET");
});
it("a cold missing Host or fixed Chrome management port remains explicitly unavailable while verified extension assistance works", async () => {
  const f = await fixture();
  const controller = createWindowsSetupAssistance({
    resourcesRoot: f.resources,
    modelCause: () => "model",
    os: { reveal: f.os.reveal, copy: f.os.copy },
  });
  controllers.push(controller);
  await controller.refresh(f.signal);
  expect(controller.snapshot()).toMatchObject({
    extension: "available",
    chrome: "unavailable",
    modelFolder: "unavailable",
  });
  await expect(
    controller.execute({ type: "OPEN_CHROME_EXTENSIONS" }, f.signal),
  ).rejects.toThrow("SETUP_ASSISTANCE_UNAVAILABLE");
  await controller.execute({ type: "REVEAL_EXTENSION" }, f.signal);
  expect(f.os.reveal).toHaveBeenCalledWith(join(f.resources, "extension"));
});
it("parses only named assistance commands and never coerces untrusted values into privileged actions", () => {
  const coerce = vi.fn(() => "REVEAL_EXTENSION");
  expect(() =>
    parseSetupAssistanceCommand({ type: { toString: coerce } }),
  ).toThrow("INVALID_COMMAND");
  expect(coerce).not.toHaveBeenCalled();
  expect(() =>
    parseSetupAssistanceCommand({
      type: "REVEAL_EXTENSION",
      path: "C:\\Users\\private",
    }),
  ).toThrow("INVALID_COMMAND");
  expect(() =>
    parseSetupAssistanceCommand({
      type: "OPEN_URL",
      url: "chrome://extensions",
    }),
  ).toThrow("INVALID_COMMAND");
});
