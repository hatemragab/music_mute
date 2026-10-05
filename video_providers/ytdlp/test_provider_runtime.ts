// Run against a patched, pinned provider checkout with its locked dependencies.
// The test process denies all network access. None of its imports generate POTs.
import axios from "axios";
import { BotGuardClient } from "bgutils-js/botguard";
import { WebPoMinter } from "bgutils-js/webpo";
import { SessionManager } from "./src/session_manager.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const manager = new SessionManager(false) as any;
let fetchCalls = 0;
const originalGet = axios.get;
axios.get = async (_url: any, options: any) => {
  fetchCalls++;
  assert(options.timeout === 5000, "provider socket timeout missing");
  throw new Error("synthetic dependency failure");
};
try {
  await manager.getFetch({ asDispatcher: () => undefined }, 1, 0)(
    "synthetic",
    {},
  );
  throw new Error("failed transport unexpectedly succeeded");
} catch (error) {
  assert(
    String(error).includes("All 1 retries failed"),
    "provider replayed transport",
  );
  assert(fetchCalls === 1, "provider made more than one request");
} finally {
  axios.get = originalGet;
}

// Per-challenge configuration remains local during async network reads.
const before = { config_: { EVENT_ID: "previous" } };
(globalThis as any).yt = before;
const challenge = {
  interpreterUrl: {
    privateDoNotAccessOrElseTrustedResourceUrlWrappedValue:
      "//synthetic.invalid",
  },
  interpreterHash: "synthetic",
  program: "synthetic",
  globalName: "synthetic",
};
const response = await manager.getDescrambledChallenge({
  fetch: async (url: string) => ({
    text: async () =>
      url.includes("www.youtube.com")
        ? `ytcfg.set({"EVENT_ID":"challenge-owned"}); window.ytAtN(${
          JSON.stringify({ R: { bgChallenge: challenge } })
        });`
        : "",
  }),
});
assert(
  response.musicmuteYtConfig.config_.EVENT_ID === "challenge-owned",
  "challenge config lost",
);
assert(
  (globalThis as any).yt === before,
  "network stage mutated shared VM configuration",
);

// Ten acquisitions fetch concurrently; only the global BotGuard VM is serialized.
let networkActive = 0, maxNetwork = 0, vmActive = 0, maxVM = 0;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
manager.getDescrambledChallenge = async (_context: any, requested: any) => {
  networkActive++;
  maxNetwork = Math.max(maxNetwork, networkActive);
  await delay(5);
  networkActive--;
  return {
    ...requested,
    interpreterJavascript: {
      privateDoNotAccessOrElseSafeScriptWrappedValue: "void 0;",
    },
  };
};
const originalCreate = BotGuardClient.create;
const originalMinter = WebPoMinter.create;
(BotGuardClient as any).create = async () => ({
  snapshot: async () => {
    vmActive++;
    maxVM = Math.max(maxVM, vmActive);
    const ownConfig = (globalThis as any).yt;
    await delay(2);
    assert(
      (globalThis as any).yt === ownConfig,
      "another session overwrote BotGuard configuration",
    );
    vmActive--;
    return "synthetic-snapshot";
  },
});
(WebPoMinter as any).create = async () => ({
  mintAsWebsafeString: async () => "synthetic-token",
});
const context = {
  fetch: async () => ({ json: async () => ["synthetic-integrity", 60, 0, ""] }),
  globalObj: globalThis,
};
try {
  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      manager.generateTokenMinter(
        { key: `session-${index}` },
        context,
        { musicmuteYtConfig: { config_: { EVENT_ID: `session-${index}` } } },
      )),
  );
  assert(maxNetwork === 10, "challenge fetching was serialized");
  assert(maxVM === 1, "BotGuard VM critical section overlapped");
  for (let index = 10; index < 130; index++) {
    await manager.generateTokenMinter({ key: `session-${index}` }, context, {
      musicmuteYtConfig: { config_: { EVENT_ID: `session-${index}` } },
    });
  }
  assert(manager.minterCache.size === 128, "token minter cache is unbounded");
  assert(
    !manager.minterCache.has("session-0"),
    "oldest token minter was retained",
  );
} finally {
  (BotGuardClient as any).create = originalCreate;
  (WebPoMinter as any).create = originalMinter;
}
console.log(
  "Provider timeout, no-replay, parallel fetching, isolated VM and bounded cache passed",
);
