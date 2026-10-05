import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { MVP_MAX_DURATION_SECONDS } from "../src/shared/protocol.js";
const url = new URL("../scripts/package-chrome.mjs", import.meta.url).href;
const { validateManifest, zipFiles, staticFiles } = (await import(url)) as {
  validateManifest: (manifest: unknown, version: string) => void;
  zipFiles: (files: { name: string; bytes: Buffer }[]) => Buffer;
  staticFiles: string[];
};
const manifest = JSON.parse(
  await readFile(
    new URL("../src/extension/static/manifest.json", import.meta.url),
    "utf8",
  ),
);

describe("Chrome Web Store packaging", () => {
  it("keeps the popup duration claim aligned with the shared limit", async () => {
    const popup = await readFile(
      new URL("../src/extension/static/popup.html", import.meta.url),
      "utf8",
    );
    expect(popup).toContain(`Up to ${MVP_MAX_DURATION_SECONDS / 60} min`);
    expect(popup).not.toContain("Up to 15 min");
  });
  it("accepts the release manifest and only public browser assets", () => {
    expect(() => validateManifest(manifest, manifest.version)).not.toThrow();
    expect(staticFiles).toContain("privacy.html");
    expect(staticFiles).toContain("icons/icon-128.png");
    expect(
      staticFiles.some((name) =>
        /\.map$|\.env|fixture|companion|account/.test(name),
      ),
    ).toBe(false);
  });
  it.each([
    "fixture",
    "permission",
    "remote",
    "version",
    "icon",
    "external",
    "optional",
  ])("rejects %s contamination", (kind) => {
    const candidate = structuredClone(manifest);
    if (kind === "fixture")
      candidate.content_scripts[0].matches.push("http://127.0.0.1/*");
    if (kind === "permission") candidate.permissions.push("cookies");
    if (kind === "remote")
      candidate.content_security_policy.extension_pages +=
        "; script-src https://example.com";
    if (kind === "version") candidate.version = "9.9.9";
    if (kind === "icon") delete candidate.icons[128];
    if (kind === "external")
      candidate.externally_connectable = { matches: ["https://example.com/*"] };
    if (kind === "optional")
      candidate.optional_host_permissions = ["<all_urls>"];
    expect(() => validateManifest(candidate, manifest.version)).toThrow();
  });
  it("creates a deterministic standard ZIP with correct CRC and root manifest", async () => {
    const files = [
      { name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) },
      { name: "icons/icon-16.png", bytes: Buffer.from([0, 1, 2, 255]) },
    ];
    const bytes = zipFiles(files);
    expect(zipFiles([...files].reverse())).toEqual(bytes);
    const directory = await mkdtemp(join(tmpdir(), "mm-chrome-zip-"));
    try {
      const path = join(directory, "package.zip");
      await writeFile(path, bytes);
      const result = execFileSync(
        "python3",
        [
          "-c",
          "import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read('icons/icon-16.png') == bytes([0,1,2,255]); print(json.dumps(z.namelist()))",
          path,
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(result)).toEqual([
        "icons/icon-16.png",
        "manifest.json",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(["../secret", "/secret", "a/../../secret", "a\\secret"])(
    "rejects unsafe archive path %s",
    (name) => {
      expect(() => zipFiles([{ name, bytes: Buffer.alloc(0) }])).toThrow(
        "STORE_ARCHIVE_ENTRY_INVALID",
      );
    },
  );
});
