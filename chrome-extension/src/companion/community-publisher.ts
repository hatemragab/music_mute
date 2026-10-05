import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { LocalConfig } from "./config.js";
import { publicApiOrigin } from "./desktop-service.js";
import { MacGuestCredentialStore } from "./guest-credentials.js";
import { YouTubeCommunityClient } from "./youtube-community-client.js";
import { YouTubeCommunityOutbox } from "./youtube-community-outbox.js";

/** Independent process; no Chrome pipe, account session, media grant or token in argv. */
export async function startCommunityPublisher(
  config: LocalConfig,
): Promise<void> {
  const script = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const guarded = Boolean(
    config.app_resources && config.update_lease_python_path,
  );
  const executable = guarded
    ? config.update_lease_python_path!
    : config.node_path;
  const command = [config.node_path, script, "publish-youtube"];
  const args = guarded
    ? [
        "-I",
        "-B",
        "-S",
        join(config.app_resources!, "scripts/update-lock.py"),
        "--run",
        ...command,
      ]
    : command.slice(1);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: "ignore",
      cwd: config.root,
      env: {
        ...process.env,
        MUSICMUTE_LOCAL_ROOT: config.root,
        ...(config.app_resources
          ? { MUSICMUTE_LOCAL_APP_RESOURCES: config.app_resources }
          : {}),
      },
    });
    child.once("error", () =>
      reject(new Error("COMMUNITY_PUBLISHER_UNAVAILABLE")),
    );
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export interface CommunityPublisherOptions {
  outbox?: YouTubeCommunityOutbox;
  client?: () => Promise<YouTubeCommunityClient>;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  maximum_ms?: number;
}

/** Bounded retry worker. Only local durable records are scanned; there is no status polling. */
export async function runCommunityPublisher(
  config: LocalConfig,
  options: CommunityPublisherOptions = {},
): Promise<void> {
  const outbox =
    options.outbox ??
    new YouTubeCommunityOutbox(join(config.root, "youtube-community-outbox"));
  const lifetime = AbortSignal.timeout(options.maximum_ms ?? 45 * 60_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, lifetime])
    : lifetime;
  const wait =
    options.wait ??
    (async (milliseconds, current) => {
      await delay(milliseconds, undefined, { signal: current });
    });
  let client: YouTubeCommunityClient | undefined;
  let failures = 0;
  while (!signal.aborted) {
    const records = await outbox.records();
    const actionable = records.filter(
      (record) =>
        record.state === "pending" &&
        Date.parse(record.expires_at) > Date.now() &&
        (record.publication_ready !== false || !record.publication_declared),
    );
    if (!actionable.length) return;
    let busy = false;
    try {
      client ??= await (options.client?.() ??
        (async () =>
          new YouTubeCommunityClient(
            await publicApiOrigin(config),
            new MacGuestCredentialStore(config),
          ))());
      await outbox.drain(client, signal);
    } catch (error) {
      busy = error instanceof Error && error.message === "LOCAL_COMPANION_BUSY";
      // A failed session/bootstrap is refreshed on the next bounded attempt.
      if (!busy) client = undefined;
    }
    if (signal.aborted) return;
    const remaining = (await outbox.records()).filter(
      (record) =>
        record.state === "pending" &&
        Date.parse(record.expires_at) > Date.now() &&
        (record.publication_ready !== false || !record.publication_declared),
    );
    if (!remaining.length) return;
    failures = remaining.length < actionable.length ? 0 : failures + 1;
    // Competing Chrome/Mac publishers share the outbox's OS-process lease.
    // Busy waits touch local metadata only; failed transfers back off to five minutes.
    const milliseconds = busy
      ? 1000
      : Math.min(300_000, 1000 * 2 ** Math.min(failures, 9));
    await wait(milliseconds, signal).catch(() => {});
  }
}
