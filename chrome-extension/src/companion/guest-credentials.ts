import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalConfig } from "./config.js";

export interface GuestCredential {
  token: string;
  expires_at: string;
}
export interface GuestCredentialStore {
  load(): Promise<GuestCredential | null>;
  save(credential: GuestCredential): Promise<void>;
}
export function validGuestCredential(value: unknown): value is GuestCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const credential = value as Record<string, unknown>;
  return (
    Object.keys(credential).length === 2 &&
    typeof credential.token === "string" &&
    /^[A-Za-z0-9_-]{43,128}(?![\s\S])/.test(credential.token) &&
    typeof credential.expires_at === "string" &&
    credential.expires_at.length <= 40 &&
    Number.isFinite(Date.parse(credential.expires_at))
  );
}

/** Signed native helper uses macOS Security directly; secrets travel only in pipes. */
export class MacGuestCredentialStore implements GuestCredentialStore {
  private readonly helper: string;
  constructor(config: Pick<LocalConfig, "app_resources">) {
    this.helper = config.app_resources
      ? join(config.app_resources, "..", "MacOS", "MusicMuteGuestCredentials")
      : join(
          dirname(fileURLToPath(import.meta.url)),
          "MusicMuteGuestCredentials",
        );
  }
  async load(): Promise<GuestCredential | null> {
    const value = await this.execute({ operation: "load" });
    if (value === null) return null;
    if (!validGuestCredential(value))
      throw new Error("GUEST_CREDENTIALS_UNAVAILABLE");
    return value;
  }
  async save(credential: GuestCredential): Promise<void> {
    if (!validGuestCredential(credential))
      throw new Error("GUEST_CREDENTIALS_UNAVAILABLE");
    await this.execute({ operation: "save", credential });
  }
  private execute(command: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.helper, [], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failed = false;
      const fail = () => {
        if (failed) return;
        failed = true;
        child.kill("SIGKILL");
        reject(new Error("GUEST_CREDENTIALS_UNAVAILABLE"));
      };
      const timeout = setTimeout(fail, 10_000);
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096) fail();
        else chunks.push(chunk);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (failed) return;
        if (code !== 0) {
          fail();
          return;
        }
        try {
          resolve(
            JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          );
        } catch {
          fail();
        }
      });
      child.stdin.end(JSON.stringify(command));
    });
  }
}
