// Owned one-shot adapter for bgutil 2.0.1. No daemon, account state or ambient proxy.
import { SessionManager } from "./session_manager.ts";
import { createCanvas } from "canvas";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log("2.0.1");
  process.exit(0);
}
if (args.length === 1 && args[0] === "--musicmute-check") {
  const ctx = createCanvas(2, 2).getContext("2d");
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 2, 2);
  if (ctx.getImageData(0, 0, 1, 1).data[0] !== 255) process.exit(1);
  // Construct the actual provider graph without contacting YouTube.
  new SessionManager(false, {});
  console.log("ready");
  process.exit(0);
}
const parsed = new Map<string, string>();
let bypass = false;
for (let index = 0; index < args.length;) {
  const name = args[index];
  if (name === "--bypass-cache" && !bypass) {
    bypass = true;
    index++;
    continue;
  }
  const value = args[index + 1];
  if (
    !name ||
    !["-c", "--innertube-context"].includes(name) ||
    !value ||
    parsed.has(name)
  ) {
    console.error("PO_TOKEN_PROVIDER_ARGUMENTS_INVALID");
    process.exit(1);
  }
  parsed.set(name, value);
  index += 2;
}
const contentBinding = parsed.get("-c");
if (!contentBinding || !/^[A-Za-z0-9_=%-]{1,4096}$/.test(contentBinding)) {
  console.error("PO_TOKEN_PROVIDER_ARGUMENTS_INVALID");
  process.exit(1);
}
let context;
try {
  const raw = parsed.get("--innertube-context") ?? "{}";
  if (raw.length > 16384) throw new Error();
  context = JSON.parse(raw);
  if (!context || typeof context !== "object" || Array.isArray(context))
    throw new Error();
} catch {
  console.error("PO_TOKEN_PROVIDER_ARGUMENTS_INVALID");
  process.exit(1);
}
const cachePath = join(process.env.XDG_CACHE_HOME!, "bgutil-cache.json");
const cache: Record<
  string,
  { poToken: string; contentBinding: string; expiresAt: Date }
> = {};
try {
  const raw = readFileSync(cachePath, "utf8");
  if (raw.length <= 262144) {
    const stored = JSON.parse(raw);
    for (const [key, item] of Object.entries(stored).slice(0, 16)) {
      const value = item as { poToken?: unknown; expiresAt?: unknown };
      if (
        /^[A-Za-z0-9_=%-]{1,4096}$/.test(key) &&
        typeof value.poToken === "string" &&
        value.poToken.length <= 8192 &&
        typeof value.expiresAt === "string"
      ) {
        const expiresAt = new Date(value.expiresAt);
        if (
          expiresAt.getTime() > Date.now() &&
          expiresAt.getTime() <= Date.now() + 3600000
        )
          cache[key] = {
            poToken: value.poToken,
            contentBinding: key,
            expiresAt,
          };
      }
    }
  }
} catch {
  /* An absent cache is normal. Never print bindings, tokens or paths. */
}
// Bound the complete operation, including library network requests and VM work.
const deadline = setTimeout(() => {
  process.stderr.write("PO_TOKEN_PROVIDER_TIMEOUT\n");
  process.exit(1);
}, 18000);
try {
  // The pinned library can log raw network details. Keep them inside this child.
  console.warn = console.error = () => {};
  const manager = new SessionManager(false, cache);
  const result = await manager.generatePoToken(
    contentBinding,
    "",
    bypass,
    undefined,
    false,
    undefined,
    context,
  );
  if (
    typeof result.poToken !== "string" ||
    !result.poToken ||
    result.poToken.length > 8192
  )
    throw new Error();
  const entries = Object.entries(
    manager.getYoutubeSessionDataCaches(true),
  ).slice(-16);
  const bounded = Object.fromEntries(
    entries.map(([key, item]) => [
      key,
      {
        ...item,
        expiresAt: new Date(
          Math.min(item.expiresAt.getTime(), Date.now() + 3600000),
        ),
      },
    ]),
  );
  const data = JSON.stringify(bounded);
  if (data.length <= 262144) writeFileSync(cachePath, data, { mode: 0o600 });
  process.stdout.write(JSON.stringify({ poToken: result.poToken }) + "\n");
} catch {
  process.stderr.write("PO_TOKEN_PROVIDER_FAILED\n");
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
