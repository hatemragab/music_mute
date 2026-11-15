import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { HostContext } from "../host-context.js";
import { SetupAssistanceController } from "./controller.js";
import { verifiedExtensionFolder } from "./extension.js";
export function createWindowsSetupAssistance(options: {
  resourcesRoot: string;
  host?: Pick<HostContext, "native" | "personalRoot">;
  /** Only the trusted Prepare component cause, never error/stage inference. */
  modelCause(): unknown;
  os: {
    openChromeExtensions?(): Promise<void>;
    reveal(path: string): Promise<void>;
    copy(text: string): Promise<void>;
  };
}) {
  const assertCurrent = (signal: AbortSignal, current: () => boolean) => {
    signal.throwIfAborted();
    if (!current()) throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
  };
  const models = async (signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    if (!options.host || options.modelCause() !== "model")
      throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
    await options.host.native.validatePath("personal", "models", "directory");
    const folder = join(options.host.personalRoot, "models"),
      actual = await lstat(folder);
    if (
      !actual.isDirectory() ||
      actual.isSymbolicLink() ||
      options.modelCause() !== "model"
    )
      throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
    signal.throwIfAborted();
    return folder;
  };
  return new SetupAssistanceController({
    inspect: async (signal) => {
      let extension = false,
        model = false;
      try {
        await verifiedExtensionFolder(options.resourcesRoot, signal);
        extension = true;
      } catch {
        signal.throwIfAborted();
      }
      try {
        await models(signal);
        model = true;
      } catch {
        signal.throwIfAborted();
      }
      return {
        extension: extension ? "available" : "unavailable",
        chrome: options.os.openChromeExtensions ? "available" : "unavailable",
        modelFolder: model ? "available" : "unavailable",
      };
    },
    openChromeExtensions: async (signal, current) => {
      assertCurrent(signal, current);
      if (!options.os.openChromeExtensions)
        throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
      await options.os.openChromeExtensions();
      assertCurrent(signal, current);
    },
    revealExtension: async (signal, current) => {
      const folder = await verifiedExtensionFolder(
        options.resourcesRoot,
        signal,
      );
      assertCurrent(signal, current);
      await options.os.reveal(folder);
    },
    copyExtensionPath: async (signal, current) => {
      const folder = await verifiedExtensionFolder(
        options.resourcesRoot,
        signal,
      );
      assertCurrent(signal, current);
      await options.os.copy(folder);
    },
    revealModelFolder: async (signal, current) => {
      const folder = await models(signal);
      assertCurrent(signal, current);
      if (options.modelCause() !== "model")
        throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
      await options.os.reveal(folder);
    },
  });
}
