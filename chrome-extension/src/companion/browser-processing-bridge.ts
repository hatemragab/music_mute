import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  desktopRecord,
  validateDesktopSession,
  type DesktopSession,
} from "../shared/desktop-protocol.js";
import type { LocalConfig } from "./config.js";
import type { LocalLibraryOwner } from "./sync-outbox.js";

export type BrowserProcessingProvider = "LOCAL_MACOS" | "ONLINE_MUSICMUTE";
type BridgeCommand =
  | { operation: "settings" }
  | {
      operation: "session";
      firebase_uid: string;
      session_generation: string;
    };
export type BrowserBridgeExecutor = (
  command: BridgeCommand,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Preferences and bearer tokens stay in the native process, never in Chrome storage/messages. */
export class BrowserProcessingBridge {
  private readonly execute: BrowserBridgeExecutor;
  constructor(
    config: Pick<LocalConfig, "root" | "app_resources">,
    execute?: BrowserBridgeExecutor,
  ) {
    const helper = config.app_resources
      ? join(config.app_resources, "..", "MacOS", "MusicMuteLocal")
      : join(
          dirname(fileURLToPath(import.meta.url)),
          "MusicMuteBrowserProcessingBridge",
        );
    this.execute =
      execute ??
      ((command, signal) => runBridge(helper, config, command, signal));
  }
  async provider(signal?: AbortSignal): Promise<BrowserProcessingProvider> {
    const value = await this.read({ operation: "settings" }, signal);
    if (
      Object.keys(value).length !== 1 ||
      !["local", "cloud"].includes(String(value.processing_mode))
    )
      throw new Error("PROCESSING_SELECTION_UNAVAILABLE");
    return value.processing_mode === "cloud"
      ? "ONLINE_MUSICMUTE"
      : "LOCAL_MACOS";
  }
  async session(
    owner: LocalLibraryOwner,
    signal?: AbortSignal,
  ): Promise<DesktopSession> {
    const value = await this.read(
      {
        operation: "session",
        firebase_uid: owner.uid,
        session_generation: owner.session_generation,
      },
      signal,
    );
    let session: DesktopSession;
    try {
      session = validateDesktopSession(value, true);
    } catch {
      throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
    }
    if (
      session.firebase_uid !== owner.uid ||
      session.session_generation !== owner.session_generation
    )
      throw new Error("ACCOUNT_CHANGED");
    return session;
  }
  private async read(
    command: BridgeCommand,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw new Error("CANCELLED");
    const value = await this.execute(command, signal);
    if (signal?.aborted) throw new Error("CANCELLED");
    if (!desktopRecord(value)) throw new Error("PROCESSING_BRIDGE_UNAVAILABLE");
    if (Object.hasOwn(value, "error_code")) {
      const code = value.error_code;
      throw new Error(
        typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)
          ? code
          : "PROCESSING_BRIDGE_UNAVAILABLE",
      );
    }
    return value;
  }
}

function runBridge(
  helper: string,
  config: Pick<LocalConfig, "root" | "app_resources">,
  command: BridgeCommand,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      helper,
      config.app_resources ? ["--browser-processing-bridge"] : [],
      {
        stdio: ["pipe", "pipe", "ignore"],
        env: {
          ...process.env,
          MUSICMUTE_LOCAL_ROOT: config.root,
          ...(config.app_resources
            ? { MUSICMUTE_LOCAL_APP_RESOURCES: config.app_resources }
            : {}),
        },
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          signal?.aborted ? "CANCELLED" : "PROCESSING_BRIDGE_UNAVAILABLE",
        ),
      );
    };
    const timer = setTimeout(
      fail,
      command.operation === "settings" ? 5_000 : 60_000,
    );
    signal?.addEventListener("abort", fail, { once: true });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024) fail();
      else if (!settled) chunks.push(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", fail);
      if (settled) return;
      if (code !== 0) return fail();
      try {
        const value: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        settled = true;
        resolve(value);
      } catch {
        fail();
      }
    });
    if (signal?.aborted) fail();
    else child.stdin.end(JSON.stringify(command));
  });
}
