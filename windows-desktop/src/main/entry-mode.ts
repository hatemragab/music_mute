import { win32 } from "node:path";
import { desktopInputPathIsSafe } from "../../../chrome-extension/src/shared/local-platform.js";
import { STORE_BROWSER_ORIGIN } from "./browser/store-registration.js";
export type DesktopEntryMode =
  | { kind: "ui" }
  | { kind: "headless-account" }
  | { kind: "installer"; action: "install" | "uninstall" | "register" }
  | { kind: "browser"; arguments: string[] };
/** Hidden native modes are closed argument grammars, never general execution hooks. */
export function desktopEntryMode(
  argv: readonly string[],
  resourcesRoot: string,
  store = process.platform === "win32" && process.windowsStore === true,
): DesktopEntryMode {
  if (argv[0] === "--installer-maintenance") {
    if (
      store ||
      argv.length !== 2 ||
      (argv[1] !== "install" &&
        argv[1] !== "uninstall" &&
        argv[1] !== "register")
    )
      throw new Error("ENTRY_ARGUMENT_INVALID");
    return { kind: "installer", action: argv[1] };
  }
  if (argv[0] === "--headless-account") {
    if (argv.length !== 1) throw new Error("ENTRY_ARGUMENT_INVALID");
    return { kind: "headless-account" };
  }
  if (argv[0] === "--native-browser-stdio") {
    if (
      argv.length !== (store ? 9 : 5) ||
      argv[1] !== "--origin" ||
      argv[3] !== "--resources" ||
      !/^chrome-extension:\/\/[a-p]{32}\/?$/u.test(argv[2] ?? "") ||
      !desktopInputPathIsSafe(argv[4] ?? "", "win32") ||
      win32.resolve(argv[4]!).toLowerCase() !==
        win32.resolve(resourcesRoot).toLowerCase()
    )
      throw new Error("ENTRY_ARGUMENT_INVALID");
    if (
      store &&
      (argv[2] !== STORE_BROWSER_ORIGIN ||
        argv[5] !== "--store-browser-host" ||
        !/^[1-9][0-9]{0,9}$/u.test(argv[6] ?? "") ||
        Number(argv[6]) > 0xffffffff ||
        argv[7] !== "--store-browser-nonce" ||
        !/^[a-f0-9]{64}$/u.test(argv[8] ?? ""))
    )
      throw new Error("ENTRY_ARGUMENT_INVALID");
    return {
      kind: "browser",
      arguments: [
        "--origin",
        argv[2]!,
        "--resources",
        resourcesRoot,
        ...(store ? argv.slice(5) : []),
      ],
    };
  }
  if (
    argv.some(
      (value) =>
        value === "--native-browser-stdio" ||
        value === "--headless-account" ||
        value === "--installer-maintenance" ||
        value === "--store-browser-host" ||
        value === "--store-browser-nonce",
    )
  )
    throw new Error("ENTRY_ARGUMENT_INVALID");
  return { kind: "ui" };
}
/** Existing authority forwarding may activate UI or acknowledge its headless
 * peer. Hidden worker/installer/browser modes never become GUI event effects. */
export function forwardedDesktopEntryMode(
  argv: readonly string[],
  resourcesRoot: string,
): "ui" | "headless-account" | null {
  try {
    const entry = desktopEntryMode(argv, resourcesRoot);
    return entry.kind === "ui" || entry.kind === "headless-account"
      ? entry.kind
      : null;
  } catch {
    return null;
  }
}
