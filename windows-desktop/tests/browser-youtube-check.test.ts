import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseBrowserYoutubeCheckConfiguration,
  parseBrowserYoutubeCheckResult,
  runBrowserYoutubeCheckChild,
  type YoutubeCheckExecute,
} from "../src/main/browser/youtube-check-child.js";
import {
  WINDOWS_CONSUMER_DOWNLOADER_WHEELS,
  WINDOWS_CONSUMER_PINS,
} from "../../worker/src/platform/windows/consumer-pins.js";
import type { HostContext } from "../src/main/host-context.js";
const boundary = vi.hoisted(() => ({ hash: vi.fn(), write: vi.fn() }));
vi.mock("../src/main/prepare/private-files.js", () => ({
  hashPrivateFile: boundary.hash,
  writePrivateAtomic: boundary.write,
}));
const configuration = () =>
  parseBrowserYoutubeCheckConfiguration({
    version: 1,
    operation: "browser_check_youtube",
    requestId: randomUUID(),
    executionId: randomUUID(),
    release: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    helperSha256: "c".repeat(64),
    sid: "S-1-5-21-1-2-3-1001",
  });
const help =
  "--no-plugin-dirs --no-cache-dir --no-remote-components --no-js-runtimes --js-runtimes --dump-single-json";
function fixture() {
  const validatePath = vi.fn(async () => {}),
    host = {
      personalRoot: "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal",
      native: { validatePath },
    } as unknown as HostContext,
    calls: {
      file: string;
      args: string[];
      options: Parameters<YoutubeCheckExecute>[2];
    }[] = [];
  const run: YoutubeCheckExecute = async (file, args, options) => {
    calls.push({ file, args, options });
    return {
      stdout: args.includes("--help")
        ? help
        : args.includes("--musicmute-check-ejs")
          ? "ready"
          : file.endsWith("python.exe")
            ? WINDOWS_CONSUMER_PINS.downloader
            : args.length === 1
              ? `deno ${WINDOWS_CONSUMER_PINS.deno}\nv8 fixture`
              : "ready",
    };
  };
  return { host, validatePath, calls, run };
}
beforeEach(() => {
  boundary.write.mockReset();
  boundary.hash.mockReset();
  boundary.hash.mockImplementation(async (_host, path: string) => {
    if (path.endsWith("downloader_bootstrap.py"))
      return WINDOWS_CONSUMER_PINS.downloaderBootstrapSha256;
    if (path.endsWith("generate_once.ts"))
      return WINDOWS_CONSUMER_PINS.providerScriptSha256;
    if (path.endsWith("session_manager.ts"))
      return WINDOWS_CONSUMER_PINS.providerSessionSha256;
    return WINDOWS_CONSUMER_DOWNLOADER_WHEELS.find((w) => path.endsWith(w.file))
      ?.sha256;
  });
});
describe("fixed offline Windows YouTube-tool CHECK child", () => {
  it("executes only pinned isolated Python/Deno with bounded offline protocol checks", async () => {
    const f = fixture(),
      c = configuration();
    vi.stubEnv("GOOGLE_TOKEN", "synthetic-secret");
    vi.stubEnv("MUSICMUTE_OWNERSHIP_NONCE", "secret");
    try {
      await runBrowserYoutubeCheckChild(
        f.host,
        c,
        `C:\\runtime\\${c.release}`,
        f.run,
      );
      expect(f.validatePath).toHaveBeenCalledExactlyOnceWith(
        "personal",
        `cloud\\work\\${c.requestId}`,
        "directory",
      );
      expect(boundary.hash).toHaveBeenCalledTimes(6);
      expect(f.calls).toHaveLength(5);
      for (const { file, args, options } of f.calls) {
        expect(file.startsWith(`C:\\runtime\\${c.release}\\`)).toBe(true);
        expect(options).toMatchObject({ windowsHide: true, timeout: 30000 });
        expect(options.maxBuffer).toBeLessThanOrEqual(131072);
        expect(options.env.GOOGLE_TOKEN).toBeUndefined();
        expect(options.env.MUSICMUTE_OWNERSHIP_NONCE).toBeUndefined();
        expect(options.env.HOME).toBe(options.cwd);
        expect(args).not.toContain("--allow-net");
        expect(args.join(" ")).not.toMatch(/https?:|youtu\.be/u);
        if (file.endsWith("python.exe"))
          expect(args.slice(0, 3)).toEqual(["-I", "-B", "-S"]);
      }
      expect(f.calls.at(-1)?.args).toEqual(
        expect.arrayContaining(["--cached-only", "--frozen", "--deny-net"]),
      );
      const [host, relative, bytes] = boundary.write.mock.calls[0]!;
      expect(host).toBe(f.host);
      expect(relative).toBe(
        `cloud\\work\\${c.requestId}\\youtube-check-result.json`,
      );
      expect(
        parseBrowserYoutubeCheckResult(JSON.parse(bytes.toString()), c),
      ).toMatchObject({
        passed: true,
        errorCode: null,
        inferencePerformed: false,
        networkRequests: 0,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    "downloader_bootstrap.py",
    "yt_dlp-2026.8.19-py3-none-any.whl",
    "generate_once.ts",
    "session_manager.ts",
  ])(
    "rejects replaced approved %s before any executable runs",
    async (file) => {
      const original = boundary.hash.getMockImplementation()!;
      boundary.hash.mockImplementation(async (...args) =>
        String(args[1]).endsWith(file) ? "f".repeat(64) : original(...args),
      );
      const f = fixture(),
        c = configuration();
      await runBrowserYoutubeCheckChild(
        f.host,
        c,
        `C:\\runtime\\${c.release}`,
        f.run,
      );
      expect(f.calls).toHaveLength(0);
      const result = JSON.parse(boundary.write.mock.calls[0]![2].toString());
      expect(result.passed).toBe(false);
      expect(result.errorCode).toMatch(
        /YT_DLP_IDENTITY_INVALID|PO_TOKEN_PROVIDER_UNAVAILABLE/u,
      );
    },
  );
  it("bounds hostile executable failures and rejects changed result/request identities", async () => {
    const f = fixture(),
      c = configuration();
    await runBrowserYoutubeCheckChild(
      f.host,
      c,
      `C:\\runtime\\${c.release}`,
      async () => {
        throw new Error("C:\\private\\secret Bearer token");
      },
    );
    const result = JSON.parse(boundary.write.mock.calls[0]![2].toString());
    expect(result.errorCode).toBe("YOUTUBE_TOOLS_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toMatch(/Bearer|secret|private/u);
    expect(() =>
      parseBrowserYoutubeCheckResult({ ...result, requestId: randomUUID() }, c),
    ).toThrow("INSTALLATION_CHECK_FAILED");
    expect(() =>
      parseBrowserYoutubeCheckResult({ ...result, networkRequests: 1 }, c),
    ).toThrow("INSTALLATION_CHECK_FAILED");
    expect(() =>
      parseBrowserYoutubeCheckResult(
        { ...result, errorCode: "UPPERCASE_PRIVATE_SECRET" },
        c,
      ),
    ).toThrow("INSTALLATION_CHECK_FAILED");
    expect(() =>
      parseBrowserYoutubeCheckConfiguration({
        ...c,
        url: "https://youtube.com",
      }),
    ).toThrow("INSTALLATION_CHECK_FAILED");
  });
  it("missing fixed CLI flags prevents EJS/provider execution", async () => {
    const f = fixture(),
      c = configuration();
    await runBrowserYoutubeCheckChild(
      f.host,
      c,
      `C:\\runtime\\${c.release}`,
      async (file, args, options) =>
        args.includes("--help")
          ? { stdout: "--version" }
          : f.run(file, args, options),
    );
    expect(
      f.calls.some(({ args }) => args.includes("--musicmute-check-ejs")),
    ).toBe(false);
    expect(
      JSON.parse(boundary.write.mock.calls[0]![2].toString()).errorCode,
    ).toBe("CLI_OPTION_UNSUPPORTED");
  });
});
