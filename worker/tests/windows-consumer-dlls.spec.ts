import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { readWindowsX64Imports } from "../src/platform/windows/pe-imports.js";
import { auditWindowsConsumerDlls } from "../src/platform/windows/consumer-dlls.js";
import { windowsConsumerProbeEnvironment } from "../src/platform/windows/consumer-package.js";
import { fixturePe64 } from "./fixtures/windows-pe64.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-dll-fixture-"));
  roots.push(root);
  const files: string[] = [];
  const put = async (relative: string, bytes: Buffer | string) => {
    const path = join(root, ...relative.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    if (!files.includes(path)) files.push(path);
    return path;
  };
  const pin = async (relative: string) => {
    const bytes = await readFile(join(root, ...relative.split("/")));
    return {
      path: relative,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const wheel = async (distribution: string, members: readonly string[]) => {
    const path = `runtime/python/Lib/site-packages/${distribution}-1.0.dist-info/RECORD`;
    const rows = await Promise.all(
      members.map(async (member) => {
        const data = await readFile(join(root, ...member.split("/")));
        return `${member.slice("runtime/python/Lib/site-packages/".length)},sha256=${createHash("sha256").update(data).digest("base64url")},${data.length}`;
      }),
    );
    await put(
      path,
      rows.join("\r\n") + `\r\n${distribution}-1.0.dist-info/RECORD,,\r\n`,
    );
    return pin(path);
  };
  const bootstrap = async (path: string) => {
    const bytes = await readFile(
      fileURLToPath(
        new URL(`./fixtures/windows-wheel-bootstrap/${path}`, import.meta.url),
      ),
    );
    return put(`runtime/python/Lib/site-packages/${path}`, bytes);
  };
  const notice = async (libraries: readonly string[]) => {
    const license = "runtime/python/licenses/msvc/LICENSE.txt",
      text = Buffer.from(
        "Synthetic notice fixture. No redistribution rights are asserted.",
      );
    await put(license, text);
    const record = {
      schemaVersion: 1,
      architecture: "x64",
      sourceUrl: "https://aka.ms/vs/17/release/vc_redist.x64.exe",
      version: "14.44.35211",
      license: await pin(license),
      files: await Promise.all(libraries.map(pin)),
    };
    await put("runtime/python/redistributables.json", JSON.stringify(record));
    return record;
  };
  const scopedNotice = async (
    groups: readonly {
      record: Awaited<ReturnType<typeof pin>> | null;
      version: string;
      libraries: readonly string[];
    }[],
  ) => {
    const license = "runtime/python/licenses/msvc/LICENSE.txt";
    await put(
      license,
      "Synthetic runtime notice; no distribution rights asserted.",
    );
    const record = {
      schemaVersion: 3,
      architecture: "x64",
      groups: await Promise.all(
        groups.map(async (group) => ({
          kind: group.record ? "wheel" : "executable",
          record: group.record,
          sourceUrl:
            "https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/",
          license: await pin(license),
          files: await Promise.all(
            group.libraries.map(async (path) => ({
              ...(await pin(path)),
              version: group.version,
            })),
          ),
        })),
      ),
    };
    await put("runtime/python/redistributables.json", JSON.stringify(record));
    return record;
  };
  return { root, files, put, notice, pin, wheel, bootstrap, scopedNotice };
}
it("reads ordinary and RVA-based delayed imports from structural PE64 fixtures without executing them", async () => {
  const f = await fixture(),
    path = await f.put(
      "runtime/python/python.exe",
      fixturePe64([
        { name: "KERNEL32.DLL", kind: "import" },
        { name: "VCRUNTIME140.dll", kind: "delay" },
      ]),
    );
  expect(await readWindowsX64Imports(path)).toEqual([
    { name: "kernel32.dll", kind: "import" },
    { name: "vcruntime140.dll", kind: "delay" },
  ]);
});
it("reads valid GNU library names containing plus signs without allowing path syntax", async () => {
  const f = await fixture();
  const path = await f.put(
    "tools/youtube/provider/native.dll",
    fixturePe64([{ name: "libstdc++-6.dll", kind: "import" }]),
  );
  expect(await readWindowsX64Imports(path)).toEqual([
    { name: "libstdc++-6.dll", kind: "import" },
  ]);
});
it.each(["import", "delay"] as const)(
  "bounds %s descriptors while accepting a larger fully mapped thunk/name payload",
  async (kind) => {
    const f = await fixture();
    const original = fixturePe64([{ name: "private.dll", kind }]);
    const bytes = Buffer.alloc(100000);
    original.copy(bytes);
    const optional = 152,
      section = optional + 240;
    bytes.writeUInt32LE(106496, optional + 56);
    bytes.writeUInt32LE(bytes.length - 512, section + 8);
    bytes.writeUInt32LE(bytes.length - 512, section + 16);
    const sizeField = optional + 116 + (kind === "import" ? 1 : 13) * 8;
    bytes.writeUInt32LE(93576, sizeField);
    const path = await f.put("runtime/python/private.dll", bytes);
    expect(await readWindowsX64Imports(path)).toEqual([
      { name: "private.dll", kind },
    ]);
    // An advertised range outside the backing section is still invalid even
    // when the descriptor prefix itself would fit and terminate normally.
    bytes.writeUInt32LE(bytes.length, sizeField);
    await writeFile(path, bytes);
    await expect(readWindowsX64Imports(path)).rejects.toThrow(
      "invalid or unsupported",
    );
  },
);
it.each(["import", "delay"] as const)(
  "projects split %s descriptors once while retaining the separate ordinary/delay dependency",
  async (kind) => {
    const f = await fixture();
    const path = await f.put(
      "runtime/python/private.dll",
      fixturePe64([
        { name: "KERNEL32.DLL", kind },
        { name: "kernel32.dll", kind },
        { name: "kernel32.dll", kind: kind === "import" ? "delay" : "import" },
      ]),
    );
    expect(await readWindowsX64Imports(path)).toEqual([
      { name: "kernel32.dll", kind: "import" },
      { name: "kernel32.dll", kind: "delay" },
    ]);
  },
);
it.each([2048, 2049])(
  "bounds actual descriptor count even when all %i descriptors repeat one library",
  async (count) => {
    const f = await fixture();
    const bytes = Buffer.alloc(70000);
    fixturePe64().copy(bytes);
    const optional = 152,
      section = optional + 240;
    bytes.writeUInt32LE(77824, optional + 56);
    bytes.writeUInt32LE(bytes.length - 512, section + 8);
    bytes.writeUInt32LE(bytes.length - 512, section + 16);
    bytes.writeUInt32LE(4096, optional + 120);
    bytes.writeUInt32LE((count + 1) * 20, optional + 124);
    bytes.write("kernel32.dll\0", 68000, "ascii");
    for (let i = 0; i < count; i++)
      bytes.writeUInt32LE(68000 - 512 + 4096, 512 + i * 20 + 12);
    const path = await f.put("runtime/python/private.dll", bytes);
    if (count === 2048)
      expect(await readWindowsX64Imports(path)).toEqual([
        { name: "kernel32.dll", kind: "import" },
      ]);
    else
      await expect(readWindowsX64Imports(path)).rejects.toThrow(
        "invalid or unsupported",
      );
  },
);
it.each(["import", "delay"] as const)(
  "recognizes the exact Node-API host in a real DLL-format .node addon (%s)",
  async (kind) => {
    const f = await fixture();
    const bytes = fixturePe64([{ name: "node.exe", kind }]);
    bytes.writeUInt16LE(0x2000, 128 + 22);
    const path = await f.put("tools/youtube/provider/canvas.node", bytes);
    expect(await readWindowsX64Imports(path)).toEqual([
      { name: "node.exe", kind },
    ]);
    const fake = Buffer.from(bytes);
    fake.writeUInt16LE(0, 128 + 22);
    await expect(
      readWindowsX64Imports(
        await f.put("tools/youtube/provider/renamed.node", fake),
      ),
    ).rejects.toThrow();
    await expect(
      readWindowsX64Imports(
        await f.put("tools/youtube/provider/ordinary.dll", bytes),
      ),
    ).rejects.toThrow();
  },
);
it.each([
  "other.exe",
  "../node.exe",
  "node.exe:stream",
  "node.exe.dll/escape",
  "libstdc++-6.dll/escape",
])(
  "denies unsupported host or path import %s even in an addon",
  async (name) => {
    const f = await fixture();
    const bytes = fixturePe64([{ name, kind: "delay" }]);
    bytes.writeUInt16LE(0x2000, 128 + 22);
    await expect(
      readWindowsX64Imports(
        await f.put("tools/youtube/provider/canvas.node", bytes),
      ),
    ).rejects.toThrow();
  },
);
it("binds provider Node-API imports to its inventoried Deno host and keeps GNU dependencies adjacent", async () => {
  const f = await fixture();
  const addon = fixturePe64([
    { name: "node.exe", kind: "delay" },
    { name: "libstdc++-6.dll", kind: "import" },
  ]);
  addon.writeUInt16LE(0x2000, 128 + 22);
  await f.put(
    "tools/youtube/provider/node_modules/canvas/build/Release/canvas.node",
    addon,
  );
  await f.put(
    "tools/youtube/provider/node_modules/canvas/build/Release/libstdc++-6.dll",
    fixturePe64(),
  );
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "inventoried host",
  );
  await f.put("tools/youtube/bin/deno.exe", fixturePe64());
  const audit = await auditWindowsConsumerDlls(f.root, f.files);
  expect(audit.imports).toContainEqual({
    binary:
      "tools/youtube/provider/node_modules/canvas/build/Release/canvas.node",
    name: "node.exe",
    kind: "delay",
    source: "node-api-host",
    path: "tools/youtube/bin/deno.exe",
  });
  expect(audit.imports).toContainEqual({
    binary:
      "tools/youtube/provider/node_modules/canvas/build/Release/canvas.node",
    name: "libstdc++-6.dll",
    kind: "import",
    source: "private",
    path: "tools/youtube/provider/node_modules/canvas/build/Release/libstdc++-6.dll",
  });
});
it("binds app addons to Node and denies host imports in unrelated components", async () => {
  const f = await fixture();
  const addon = fixturePe64([{ name: "node.exe", kind: "delay" }]);
  addon.writeUInt16LE(0x2000, 128 + 22);
  await f.put("app/node_modules/addon/addon.node", addon);
  await f.put("runtime/node/node.exe", fixturePe64());
  expect(
    (await auditWindowsConsumerDlls(f.root, f.files)).imports[0],
  ).toMatchObject({ source: "node-api-host", path: "runtime/node/node.exe" });
  await f.put("runtime/python/unexpected.node", addon);
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "supported inventoried host",
  );
});
it.each([
  "truncated",
  "arm64",
  "optional",
  "unmapped",
  "huge-table",
  "unterminated",
  "old-delay",
  "path-name",
])(
  "rejects %s import-table bytes before declaring dependency closure",
  async (mode) => {
    const f = await fixture();
    let bytes = fixturePe64(
      mode === "old-delay"
        ? [{ name: "private.dll", kind: "delay" }]
        : [{ name: "private.dll", kind: "import" }],
    );
    const optional = 152;
    if (mode === "truncated") bytes = bytes.subarray(0, 200);
    if (mode === "arm64") bytes.writeUInt16LE(0xaa64, 132);
    if (mode === "optional") bytes.writeUInt16LE(112, 148);
    if (mode === "unmapped") bytes.writeUInt32LE(9000, 524);
    if (mode === "huge-table") bytes.writeUInt32LE(65537, optional + 124);
    if (mode === "unterminated") bytes.writeUInt32LE(20, optional + 124);
    if (mode === "old-delay") bytes.writeUInt32LE(0, 1024);
    if (mode === "path-name") bytes.write("../file.dll\0", 1536);
    const path = await f.put("runtime/python/python.exe", bytes);
    await expect(readWindowsX64Imports(path)).rejects.toThrow(
      "invalid or unsupported",
    );
  },
);
it("rejects a symlink to structurally valid bytes instead of treating target inode alone as the input", async () => {
  const f = await fixture(),
    original = await f.put("runtime/python/original.exe", fixturePe64()),
    link = join(f.root, "runtime/python/link.exe");
  await symlink(original, link);
  await expect(readWindowsX64Imports(link)).rejects.toThrow();
});
it("resolves actual private ordinary/delay dependencies and records only relative graph paths plus OS imports", async () => {
  const f = await fixture();
  await f.put(
    "runtime/python/python.exe",
    fixturePe64([
      { name: "python312.dll", kind: "import" },
      { name: "KERNEL32.DLL", kind: "delay" },
    ]),
  );
  await f.put(
    "runtime/python/python312.dll",
    fixturePe64([{ name: "vcruntime140.dll", kind: "import" }]),
  );
  await f.put(
    "runtime/python/vcruntime140.dll",
    fixturePe64([
      { name: "api-ms-win-crt-runtime-l1-1-0.dll", kind: "import" },
    ]),
  );
  await f.notice(["runtime/python/vcruntime140.dll"]);
  const result = await auditWindowsConsumerDlls(f.root, f.files);
  expect(result.binaryCount).toBe(3);
  expect(result.imports).toContainEqual({
    binary: "runtime/python/python312.dll",
    name: "vcruntime140.dll",
    kind: "import",
    source: "private",
    path: "runtime/python/vcruntime140.dll",
  });
  expect(result.msvc?.version).toBe("14.44.35211");
  expect(JSON.stringify(result)).not.toContain(f.root);
});
it.each(["MusicMuteWorker.exe", "MusicMuteSession.exe"])(
  "audits the exact Store root launcher %s with ordinary and delayed OS imports",
  async (binary) => {
    const f = await fixture();
    await f.put(
      binary,
      fixturePe64([
        { name: "KERNEL32.DLL", kind: "import" },
        { name: "XmlLite.DLL", kind: "delay" },
      ]),
    );
    const result = await auditWindowsConsumerDlls(f.root, f.files);
    expect(result.binaryCount).toBe(1);
    expect(result.imports).toEqual([
      { binary, name: "kernel32.dll", kind: "import", source: "windows" },
      { binary, name: "xmllite.dll", kind: "delay", source: "windows" },
    ]);
    expect(result.msvc).toBeNull();
  },
);
it.each([
  "other.exe",
  "musicmuteworker.exe",
  "MusicMuteWorker-extra.exe",
  "MusicMuteWorker.dll",
  "MusicMuteSession.dll",
  "private.dll",
  "MusicMuteWorker.exe/private.dll",
])(
  "keeps the unapproved Store root binary %s outside all private components",
  async (binary) => {
    const f = await fixture();
    await f.put("MusicMuteSession.exe", fixturePe64());
    await f.put(binary, fixturePe64());
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "outside an approved private component",
    );
  },
);
it.each(["MusicMuteWorker.exe", "MusicMuteSession.exe"])(
  "does not let Store root launcher %s borrow a private DLL from another component",
  async (binary) => {
    const f = await fixture();
    await f.put(binary, fixturePe64([{ name: "private.dll", kind: "delay" }]));
    await f.put("runtime/native/private.dll", fixturePe64());
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "missing or ambiguous inside private component",
    );
  },
);
it.each(["kernel32.dll", "xmllite.dll"])(
  "denies root OS DLL shadow %s beside an approved Store launcher",
  async (name) => {
    const f = await fixture();
    await f.put("MusicMuteWorker.exe", fixturePe64([{ name, kind: "import" }]));
    await f.put(name, fixturePe64());
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "must not redistribute Windows",
    );
  },
);
it("a builder-global or unrelated-component VC DLL cannot satisfy a missing actual app-local dependency", async () => {
  const f = await fixture();
  await f.put(
    "runtime/python/python.exe",
    fixturePe64([{ name: "vcruntime140.dll", kind: "delay" }]),
  );
  await f.put("runtime/native/vcruntime140.dll", fixturePe64());
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "missing or ambiguous",
  );
  await f.put(
    "runtime/python/Lib/site-packages/unrelated/vcruntime140.dll",
    fixturePe64(),
  );
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "missing or ambiguous",
  );
});
it.each([
  "ucrtbase.dll",
  "api-ms-win-core-file-l1-1-0.dll",
  "kernel32.dll",
  "avicap32.dll",
  "cabinet.dll",
  "msi.dll",
  "ktmw32.dll",
  "dwrite.dll",
  "gdiplus.dll",
  "opengl32.dll",
  "rstrtmgr.dll",
  "xmllite.dll",
])("forbids copying OS/API-set %s into the payload", async (name) => {
  const f = await fixture();
  await f.put(`runtime/python/${name}`, fixturePe64());
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "must not redistribute Windows",
  );
});
it.each(["dwrite.dll", "gdiplus.dll", "opengl32.dll", "rstrtmgr.dll"])(
  "recognizes supported Windows dependency %s without an ambient private copy",
  async (name) => {
    const f = await fixture();
    await f.put(
      "tools/youtube/bin/deno.exe",
      fixturePe64([{ name, kind: "import" }]),
    );
    expect((await auditWindowsConsumerDlls(f.root, f.files)).imports).toEqual([
      {
        binary: "tools/youtube/bin/deno.exe",
        name,
        kind: "import",
        source: "windows",
      },
    ]);
  },
);
it("recognizes the documented Windows transaction OS import without adding private DLLs", async () => {
  const f = await fixture();
  await f.put(
    "runtime/native/musicmute-native.exe",
    fixturePe64([{ name: "KtmW32.dll", kind: "import" }]),
  );
  expect((await auditWindowsConsumerDlls(f.root, f.files)).imports).toEqual([
    {
      binary: "runtime/native/musicmute-native.exe",
      name: "ktmw32.dll",
      kind: "import",
      source: "windows",
    },
  ]);
});
it.each(["import", "delay"] as const)(
  "classifies the native helper's XmlLite %s as a Windows dependency",
  async (kind) => {
    const f = await fixture();
    await f.put(
      "runtime/native/musicmute-native.exe",
      fixturePe64([{ name: "XmlLite.DLL", kind }]),
    );
    expect((await auditWindowsConsumerDlls(f.root, f.files)).imports).toEqual([
      {
        binary: "runtime/native/musicmute-native.exe",
        name: "xmllite.dll",
        kind,
        source: "windows",
      },
    ]);
  },
);
it.each(["runtime/native/xmllite.dll", "tools/youtube/provider/XmlLite.DLL"])(
  "rejects a private shadow of XmlLite at %s",
  async (path) => {
    const f = await fixture();
    await f.put(
      "runtime/native/musicmute-native.exe",
      fixturePe64([{ name: "xmllite.dll", kind: "import" }]),
    );
    await f.put(path, fixturePe64());
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "must not redistribute Windows",
    );
  },
);
it.each(["xmllite-extra.dll", "xmllite64.dll"])(
  "keeps unapproved XmlLite-like import %s private and fails if missing",
  async (name) => {
    const f = await fixture();
    await f.put(
      "runtime/native/musicmute-native.exe",
      fixturePe64([{ name, kind: "import" }]),
    );
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "missing or ambiguous inside private component",
    );
  },
);
it.each([
  ["ffmpeg.exe", "import"],
  ["ffmpeg.exe", "delay"],
  ["ffprobe.exe", "import"],
  ["ffprobe.exe", "delay"],
] as const)(
  "classifies the Windows capture dependency of %s (%s) without a private copy",
  async (binary, kind) => {
    const f = await fixture();
    await f.put(
      `runtime/bin/${binary}`,
      fixturePe64([{ name: "AVICAP32.dll", kind }]),
    );
    expect((await auditWindowsConsumerDlls(f.root, f.files)).imports).toEqual([
      {
        binary: `runtime/bin/${binary}`,
        name: "avicap32.dll",
        kind,
        source: "windows",
      },
    ]);
  },
);
it.each(["runtime/bin/avicap32.dll", "tools/youtube/provider/AVICAP32.DLL"])(
  "rejects a bundled Windows capture DLL at %s",
  async (path) => {
    const f = await fixture();
    await f.put(
      "runtime/bin/ffmpeg.exe",
      fixturePe64([{ name: "avicap32.dll", kind: "import" }]),
    );
    await f.put(path, fixturePe64());
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "must not redistribute Windows",
    );
  },
);
it.each(["avicap32-extra.dll", "avicap64.dll"])(
  "keeps the unapproved capture-like import %s private and fails if missing",
  async (name) => {
    const f = await fixture();
    await f.put(
      "runtime/bin/ffmpeg.exe",
      fixturePe64([{ name, kind: "import" }]),
    );
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "missing or ambiguous inside private component",
    );
  },
);
it.each([
  ["cabinet.dll", "import"],
  ["cabinet.dll", "delay"],
  ["msi.dll", "import"],
  ["msi.dll", "delay"],
] as const)(
  "classifies CPython's Windows installer dependency %s (%s) without a private copy",
  async (name, kind) => {
    const f = await fixture();
    await f.put("runtime/python/DLLs/_msi.pyd", fixturePe64([{ name, kind }]));
    expect((await auditWindowsConsumerDlls(f.root, f.files)).imports).toEqual([
      {
        binary: "runtime/python/DLLs/_msi.pyd",
        name,
        kind,
        source: "windows",
      },
    ]);
  },
);
it.each([
  "runtime/python/DLLs/CABINET.DLL",
  "runtime/python/Lib/site-packages/other/msi.dll",
])(
  "rejects a private shadow of a Windows installer DLL at %s",
  async (path) => {
    const f = await fixture();
    await f.put(path, fixturePe64());
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "must not redistribute Windows",
    );
  },
);
it("a VC import with real structural private DLL bytes still fails without supplied notice/source evidence", async () => {
  const f = await fixture();
  await f.put(
    "runtime/python/python.exe",
    fixturePe64([{ name: "msvcp140.dll", kind: "import" }]),
  );
  await f.put("runtime/python/msvcp140.dll", fixturePe64());
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toMatchObject(
    { code: "ENOENT" },
  );
});
it.each([
  "license-hash",
  "dll-hash",
  "source-domain",
  "wrong-arch",
  "missing-file",
  "extra-field",
  "old-runtime",
])(
  "refuses %s redistribution evidence without changing any payload",
  async (mode) => {
    const f = await fixture();
    await f.put(
      "runtime/python/python.exe",
      fixturePe64([{ name: "vcruntime140.dll", kind: "import" }]),
    );
    await f.put("runtime/python/vcruntime140.dll", fixturePe64());
    const record = await f.notice(["runtime/python/vcruntime140.dll"]);
    if (mode === "license-hash") record.license.sha256 = "a".repeat(64);
    if (mode === "dll-hash") record.files[0]!.sha256 = "a".repeat(64);
    if (mode === "source-domain")
      record.sourceUrl = "https://vendor.example.invalid/runtime.exe";
    if (mode === "wrong-arch") record.architecture = "arm64";
    if (mode === "missing-file") record.files = [];
    if (mode === "extra-field")
      Object.assign(record, { adminInstallRequired: false });
    if (mode === "old-runtime") record.version = "14.10.10000";
    await f.put("runtime/python/redistributables.json", JSON.stringify(record));
    const before = await readFile(
      join(f.root, "runtime/python/vcruntime140.dll"),
    );
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "Consumer MSVC",
    );
    expect(
      await readFile(join(f.root, "runtime/python/vcruntime140.dll")),
    ).toEqual(before);
  },
);
it("ambiguous private libraries deny closure; a matching adjacent DLL is preferred over unrelated package libraries", async () => {
  const f = await fixture();
  await f.put(
    "runtime/python/package/module.pyd",
    fixturePe64([{ name: "support.dll", kind: "import" }]),
  );
  await f.put("runtime/python/a/support.dll", fixturePe64());
  await f.put("runtime/python/b/support.dll", fixturePe64());
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "missing or ambiguous",
  );
  await f.put("runtime/python/package/support.dll", fixturePe64());
  expect(
    (await auditWindowsConsumerDlls(f.root, f.files)).imports[0]!.path,
  ).toBe("runtime/python/package/support.dll");
});
it("sanitizes probe PATH/options/account/vendor state and routes home/temp to the owned private directory", () => {
  const root = "C:\\Build\\owned-probe",
    input = {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\GlobalPython",
      PYTHONPATH: "untrusted",
      NODE_OPTIONS: "--require bad",
      AUDIO_ACQUISITION_API_KEY: "secret",
      APPDATA: "C:\\Users\\Fixture\\Account",
      R2_SECRET_ACCESS_KEY: "secret",
    },
    result = windowsConsumerProbeEnvironment(input, root);
  expect(result).toEqual({
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    PATH: "",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    TEMP: root,
    TMP: root,
    HOME: root,
    USERPROFILE: root,
    APPDATA: root,
    LOCALAPPDATA: root,
  });
  expect(input.PATH).toBe("C:\\GlobalPython");
  expect(() =>
    windowsConsumerProbeEnvironment(
      { SystemRoot: "C:\\Windows\\..\\Other" },
      root,
    ),
  ).toThrow("canonical");
  expect(() => windowsConsumerProbeEnvironment({}, root)).toThrow();
});
it("rejects duplicate VC basenames with different bytes despite individually matching source pins", async () => {
  const f = await fixture(),
    first = fixturePe64(),
    second = fixturePe64();
  second[4000] = 1;
  await f.put("runtime/python/vcruntime140.dll", first);
  await f.put("runtime/python/Lib/site-packages/pkg/vcruntime140.dll", second);
  await f.notice([
    "runtime/python/vcruntime140.dll",
    "runtime/python/Lib/site-packages/pkg/vcruntime140.dll",
  ]);
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "MSVC source/notice",
  );
});
it.each(["vcruntime140d.dll", "msvcp140_1d.dll", "ucrtbased.dll"])(
  "rejects %s as a nonredistributable debug dependency",
  async (name) => {
    const f = await fixture();
    await f.put(
      "runtime/python/python.exe",
      fixturePe64([{ name, kind: "delay" }]),
    );
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "debug VC/UCRT",
    );
  },
);

it.each([
  ["numpy", "numpy", "numpy.libs"],
  ["ml_dtypes", "ml_dtypes", "ml_dtypes.libs"],
  ["onnx_weekly", "onnx", "onnx_weekly.libs"],
  ["llvmlite", "llvmlite", "llvmlite.libs"],
] as const)(
  "binds %s native imports to its RECORD-owned, fully pinned sibling loader despite identical other-wheel DLLs",
  async (distribution, module, directory) => {
    const f = await fixture(),
      site = "runtime/python/Lib/site-packages/",
      binary = `${site}${module}/native.pyd`,
      dependency = `${site}${directory}/shared.dll`,
      loader = `${site}${module}/__init__.py`;
    await f.bootstrap(`${module}/__init__.py`);
    await f.put(binary, fixturePe64([{ name: "shared.dll", kind: "delay" }]));
    const shared = fixturePe64();
    await f.put(dependency, shared);
    await f.wheel(distribution, [loader, binary, dependency]);
    await f.put(`${site}unrelated.libs/shared.dll`, shared);
    await f.wheel("unrelated", [`${site}unrelated.libs/shared.dll`]);
    const audit = await auditWindowsConsumerDlls(f.root, f.files);
    expect(audit.policy).toBe("private-pe-imports-msvc-v3");
    expect(audit.imports[0]).toMatchObject({
      binary,
      path: dependency,
      wheel: {
        record: { path: `${site}${distribution}-1.0.dist-info/RECORD` },
      },
    });
    expect(audit.imports[0]!.wheel!.bootstrap).toEqual([await f.pin(loader)]);
  },
);
it.each(["comment", "changed", "late"])(
  "denies a %s bootstrap even when its edited RECORD hash matches",
  async (mode) => {
    const f = await fixture(),
      site = "runtime/python/Lib/site-packages/",
      loader = `${site}ml_dtypes/__init__.py`,
      binary = `${site}ml_dtypes/native.pyd`,
      dependency = `${site}ml_dtypes.libs/shared.dll`;
    await f.bootstrap("ml_dtypes/__init__.py");
    const original = await readFile(join(f.root, loader));
    const changed =
      mode === "comment"
        ? Buffer.from(
            original
              .toString()
              .split(/\r?\n/u)
              .map((line) => `# ${line}`)
              .join("\n"),
          )
        : mode === "late"
          ? Buffer.concat([Buffer.from("import native\n"), original])
          : Buffer.concat([original, Buffer.from("\n# changed\n")]);
    await f.put(loader, changed);
    await f.put(binary, fixturePe64([{ name: "shared.dll", kind: "import" }]));
    await f.put(dependency, fixturePe64());
    await f.wheel("ml_dtypes", [loader, binary, dependency]);
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "wheel ownership/bootstrap",
    );
  },
);
it("does not use a unique DLL from another wheel or an unowned copy in the right sibling directory", async () => {
  const f = await fixture(),
    site = "runtime/python/Lib/site-packages/",
    binary = `${site}ml_dtypes/native.pyd`,
    loader = `${site}ml_dtypes/__init__.py`;
  await f.bootstrap("ml_dtypes/__init__.py");
  await f.put(binary, fixturePe64([{ name: "shared.dll", kind: "import" }]));
  await f.wheel("ml_dtypes", [loader, binary]);
  await f.put(`${site}other.libs/shared.dll`, fixturePe64());
  await f.wheel("other", [`${site}other.libs/shared.dll`]);
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "missing or ambiguous",
  );
  await f.put(`${site}ml_dtypes.libs/shared.dll`, fixturePe64());
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "missing or ambiguous",
  );
});
it.each(["importer", "dll", "loader"])(
  "rejects mismatched %s RECORD bytes without selecting another wheel",
  async (target) => {
    const f = await fixture(),
      site = "runtime/python/Lib/site-packages/",
      binary = `${site}ml_dtypes/native.pyd`,
      loader = `${site}ml_dtypes/__init__.py`,
      dependency = `${site}ml_dtypes.libs/shared.dll`;
    await f.bootstrap("ml_dtypes/__init__.py");
    await f.put(binary, fixturePe64([{ name: "shared.dll", kind: "import" }]));
    await f.put(dependency, fixturePe64());
    await f.wheel("ml_dtypes", [loader, binary, dependency]);
    const path =
      target === "importer" ? binary : target === "dll" ? dependency : loader;
    const bytes = await readFile(join(f.root, path));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await f.put(path, bytes);
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "wheel ownership/bootstrap",
    );
  },
);
it.each([
  "escape",
  "backslash",
  "duplicate",
  "bad-hash",
  "bad-csv",
  "unsupported-hash",
  "duplicate-owner",
  "invalid-utf8",
])("rejects %s wheel ownership evidence", async (mode) => {
  const f = await fixture(),
    site = "runtime/python/Lib/site-packages/",
    binary = `${site}ml_dtypes/native.pyd`,
    loader = `${site}ml_dtypes/__init__.py`,
    dependency = `${site}ml_dtypes.libs/shared.dll`;
  await f.bootstrap("ml_dtypes/__init__.py");
  await f.put(binary, fixturePe64([{ name: "shared.dll", kind: "import" }]));
  await f.put(dependency, fixturePe64());
  const record = await f.wheel("ml_dtypes", [loader, binary, dependency]);
  let text = await readFile(join(f.root, record.path), "utf8");
  if (mode === "escape")
    text = text.replace(
      "ml_dtypes/native.pyd",
      "../../../../outside/native.pyd",
    );
  if (mode === "backslash")
    text = text.replace("ml_dtypes/native.pyd", "ml_dtypes\\native.pyd");
  if (mode === "duplicate") text += text.split("\r\n")[0] + "\r\n";
  if (mode === "bad-hash")
    text = text.replace(/sha256=[A-Za-z0-9_-]{43}/u, "sha256=short");
  if (mode === "bad-csv") text = '"unterminated,sha256=abc,20\n';
  if (mode === "unsupported-hash") text = text.replace("sha256=", "sha512=");
  if (mode === "duplicate-owner") await f.wheel("another", [binary]);
  else if (mode === "invalid-utf8")
    await f.put(record.path, Buffer.from([0xff, 0xfe, 0x41]));
  else await f.put(record.path, text);
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "wheel ownership/bootstrap",
  );
});
it("keeps genuinely owned adjacent wheel DLLs strict and rejects cross-wheel adjacency", async () => {
  const f = await fixture(),
    site = "runtime/python/Lib/site-packages/",
    binary = `${site}package/native.pyd`,
    dependency = `${site}package/private.dll`;
  await f.put(binary, fixturePe64([{ name: "private.dll", kind: "import" }]));
  await f.put(dependency, fixturePe64());
  await f.wheel("package", [binary, dependency]);
  expect(
    (await auditWindowsConsumerDlls(f.root, f.files)).imports[0]!.path,
  ).toBe(dependency);
  await f.wheel("another", [dependency]);
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "wheel ownership/bootstrap",
  );
});
it("proves sklearn's exact WinDLL preload and reports separately observed primary and wheel CRT versions", async () => {
  const f = await fixture(),
    site = "runtime/python/Lib/site-packages/",
    binary = `${site}sklearn/native.pyd`,
    local = `${site}sklearn/.libs/msvcp140.dll`,
    openmp = `${site}sklearn/.libs/vcomp140.dll`,
    primary = "runtime/python/msvcp140.dll";
  await f.bootstrap("sklearn/__init__.py");
  await f.bootstrap("sklearn/_distributor_init.py");
  await f.put(binary, fixturePe64([{ name: "msvcp140.dll", kind: "import" }]));
  await f.put(primary, fixturePe64());
  const wheelBytes = fixturePe64();
  wheelBytes[4000] = 1;
  await f.put(local, wheelBytes);
  await f.put(openmp, wheelBytes);
  const record = await f.wheel("scikit_learn", [
    `${site}sklearn/__init__.py`,
    `${site}sklearn/_distributor_init.py`,
    binary,
    local,
    openmp,
  ]);
  await f.scopedNotice([
    { record: null, version: "14.44.35211.0", libraries: [primary] },
    { record, version: "14.51.36247.0", libraries: [local, openmp] },
  ]);
  const audit = await auditWindowsConsumerDlls(f.root, f.files);
  expect(audit.imports[0]!.path).toBe(local);
  expect(audit.msvc!.version).toBe("14.44.35211.0");
  expect(audit.msvc!.groups!.map((group) => group.files[0]!.version)).toEqual([
    "14.44.35211.0",
    "14.51.36247.0",
  ]);
});
it("requires exact renamed MSVC DLL coverage with RECORD ownership and individual observed version", async () => {
  const f = await fixture(),
    site = "runtime/python/Lib/site-packages/",
    name = "msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll",
    binary = `${site}ml_dtypes/native.pyd`,
    dependency = `${site}ml_dtypes.libs/${name}`,
    loader = `${site}ml_dtypes/__init__.py`;
  await f.bootstrap("ml_dtypes/__init__.py");
  await f.put(binary, fixturePe64([{ name, kind: "delay" }]));
  await f.put(dependency, fixturePe64());
  const record = await f.wheel("ml_dtypes", [binary, dependency, loader]);
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toMatchObject(
    { code: "ENOENT" },
  );
  await f.scopedNotice([
    { record, version: "14.42.34433.0", libraries: [dependency] },
  ]);
  const audit = await auditWindowsConsumerDlls(f.root, f.files);
  expect(audit.msvc!.version).toBeNull();
  expect(audit.msvc!.groups![0]!.files[0]!.path).toBe(dependency);
});
it.each(["msvcp140_atomic_wait.dll", "msvcp140_codecvt_ids.dll"])(
  "covers the exact shipped primary CRT %s rather than silently omitting its notice",
  async (name) => {
    const f = await fixture(),
      path = `runtime/python/${name}`;
    await f.put(path, fixturePe64());
    await expect(
      auditWindowsConsumerDlls(f.root, f.files),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await f.scopedNotice([
      { record: null, version: "14.44.35211.0", libraries: [path] },
    ]);
    expect(
      (await auditWindowsConsumerDlls(f.root, f.files)).msvc!.groups![0]!
        .files[0]!.path,
    ).toBe(path);
  },
);
it("does not admit renamed wheel CRT files through a legacy single-version notice", async () => {
  const f = await fixture(),
    site = "runtime/python/Lib/site-packages/",
    name = "msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll",
    binary = `${site}package/native.pyd`,
    dependency = `${site}package/${name}`;
  await f.put(binary, fixturePe64([{ name, kind: "import" }]));
  await f.put(dependency, fixturePe64());
  await f.wheel("package", [binary, dependency]);
  await f.notice([dependency]);
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "MSVC source/notice",
  );
});
it.each([
  "record-hash",
  "wrong-owner",
  "missing-file",
  "duplicate-path",
  "wrong-version",
  "extra-field",
  "primary-scope",
  "mixed-primary",
])(
  "rejects %s v3 CRT provenance while preserving the original DLLs",
  async (mode) => {
    const f = await fixture(),
      site = "runtime/python/Lib/site-packages/",
      primary = "runtime/python/msvcp140.dll",
      local = `${site}package/msvcp140.dll`;
    await f.put(primary, fixturePe64());
    const bytes = fixturePe64();
    bytes[4000] = 2;
    await f.put(local, bytes);
    const owner = await f.wheel("package", [local]);
    const record = await f.scopedNotice([
      { record: null, version: "14.44.35211.0", libraries: [primary] },
      { record: owner, version: "14.51.36247.0", libraries: [local] },
    ]);
    const group = record.groups[1]!;
    if (mode === "record-hash") group.record!.sha256 = "a".repeat(64);
    if (mode === "wrong-owner") {
      const another = await f.wheel("another", []);
      group.record = another;
    }
    if (mode === "missing-file") group.files = [];
    if (mode === "duplicate-path")
      record.groups[0]!.files.push({ ...group.files[0]! });
    if (mode === "wrong-version") group.files[0]!.version = "14.10.10000";
    if (mode === "extra-field")
      Object.assign(group, { searchPath: "runtime/python" });
    if (mode === "primary-scope") {
      group.kind = "executable";
      group.record = null;
    }
    if (mode === "mixed-primary") {
      const other = "runtime/python/vcomp140.dll";
      await f.put(other, fixturePe64());
      record.groups[0]!.files.push({
        ...(await f.pin(other)),
        version: "14.51.36247.0",
      });
    }
    await f.put("runtime/python/redistributables.json", JSON.stringify(record));
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      /Consumer (?:MSVC|Python wheel)/u,
    );
    expect(await readFile(join(f.root, local))).toEqual(bytes);
  },
);
it("keeps an optional TBB dependency fail closed without an actual private library", async () => {
  const f = await fixture();
  await f.put(
    "runtime/python/Lib/site-packages/numba/np/ufunc/tbbpool.pyd",
    fixturePe64([{ name: "tbb12.dll", kind: "import" }]),
  );
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "missing or ambiguous",
  );
});
it("binds SciPy OpenBLAS only to its own pinned sibling loader and distributor source", async () => {
  const f = await fixture(),
    site = "runtime/python/Lib/site-packages/",
    binary = `${site}scipy/linalg/native.pyd`,
    library = `${site}scipy.libs/libscipy_openblas-197ee2fc9b4d071f7e048078cac74115.dll`;
  await f.bootstrap("scipy/__init__.py");
  await f.bootstrap("scipy/_distributor_init.py");
  await f.put(
    binary,
    fixturePe64([
      {
        name: "libscipy_openblas-197ee2fc9b4d071f7e048078cac74115.dll",
        kind: "import",
      },
    ]),
  );
  await f.put(library, fixturePe64());
  await f.wheel("scipy", [
    `${site}scipy/__init__.py`,
    `${site}scipy/_distributor_init.py`,
    binary,
    library,
  ]);
  expect(
    (await auditWindowsConsumerDlls(f.root, f.files)).imports[0]!.path,
  ).toBe(library);
  await f.put(
    `${site}scipy/_distributor_init_local.py`,
    "# unreviewed local hook\n",
  );
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "wheel ownership/bootstrap",
  );
});
it.each([
  "_distributor_init_local.py",
  "_distributor_init_local.pyd",
  "_DISTRIBUTOR_INIT_LOCAL/__init__.py",
])(
  "rejects the unreviewed SciPy override %s before native imports",
  async (local) => {
    const f = await fixture(),
      site = "runtime/python/Lib/site-packages/",
      binary = `${site}scipy/native.pyd`;
    await f.bootstrap("scipy/__init__.py");
    await f.bootstrap("scipy/_distributor_init.py");
    await f.put(binary, fixturePe64());
    await f.wheel("scipy", [
      `${site}scipy/__init__.py`,
      `${site}scipy/_distributor_init.py`,
      binary,
    ]);
    await f.put(`${site}scipy/${local}`, "# replacement hook\n");
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "wheel ownership/bootstrap",
    );
  },
);
it("rejects a missing declared SciPy sibling DLL even when another wheel supplies identical bytes", async () => {
  const f = await fixture(),
    site = "runtime/python/Lib/site-packages/",
    binary = `${site}scipy/native.pyd`,
    library = `${site}scipy.libs/openblas.dll`;
  await f.bootstrap("scipy/__init__.py");
  await f.bootstrap("scipy/_distributor_init.py");
  await f.put(binary, fixturePe64([{ name: "openblas.dll", kind: "import" }]));
  await f.put(library, fixturePe64());
  await f.wheel("scipy", [
    `${site}scipy/__init__.py`,
    `${site}scipy/_distributor_init.py`,
    binary,
    library,
  ]);
  await f.put(`${site}another.libs/openblas.dll`, fixturePe64());
  await f.wheel("another", [`${site}another.libs/openblas.dll`]);
  await rm(join(f.root, library));
  f.files.splice(f.files.indexOf(join(f.root, library)), 1);
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "wheel ownership/bootstrap",
  );
});
it.each(["torch_directml", "torchvision"])(
  "admits only the actual %s→Torch preloaded dependency edge with both wheel RECORDs and complete source chain",
  async (module) => {
    const f = await fixture(),
      site = "runtime/python/Lib/site-packages/",
      binary =
        module === "torch_directml"
          ? `${site}torch_directml_native.cp312-win_amd64.pyd`
          : `${site}torchvision/_C.pyd`;
    const torchFiles = [
        "torch/__init__.py",
        "torch/_ops.py",
        "torch/_utils_internal.py",
      ],
      sources =
        module === "torch_directml"
          ? ["torch_directml/__init__.py"]
          : [
              "torchvision/__init__.py",
              "torchvision/extension.py",
              "torchvision/_internally_replaced_utils.py",
            ];
    for (const path of [...torchFiles, ...sources]) await f.bootstrap(path);
    const imports = [
      { name: "c10.dll", kind: "import" as const },
      { name: "torch_cpu.dll", kind: "delay" as const },
    ];
    if (module === "torch_directml")
      imports.push({ name: "torch_python.dll", kind: "import" });
    await f.put(binary, fixturePe64(imports));
    const libraries = ["c10.dll", "torch_cpu.dll", "torch_python.dll"].map(
      (name) => `${site}torch/lib/${name}`,
    );
    for (const path of libraries) await f.put(path, fixturePe64());
    const own = sources.map((path) => site + path);
    if (module === "torch_directml") {
      const path = `${site}torch_directml/DirectML.dll`;
      await f.put(path, fixturePe64());
      own.push(path);
    }
    await f.wheel(module, [binary, ...own]);
    const torchRecord = await f.wheel("torch", [
      ...torchFiles.map((path) => site + path),
      ...libraries,
    ]);
    const audit = await auditWindowsConsumerDlls(f.root, f.files);
    expect(audit.imports.map((row) => row.path).sort()).toEqual(
      imports.map((row) => `${site}torch/lib/${row.name}`).sort(),
    );
    expect(audit.imports[0]!.wheel!.bootstrapRecords).toContainEqual(
      torchRecord,
    );
  },
);
it.each(["torch_directml", "torchvision"])(
  "rejects an unrelated or root-directory replacement for an absent explicit %s→Torch dependency",
  async (module) => {
    const f = await fixture(),
      site = "runtime/python/Lib/site-packages/",
      binary =
        module === "torch_directml"
          ? `${site}torch_directml_native.pyd`
          : `${site}torchvision/_C.pyd`;
    const torchFiles = [
        "torch/__init__.py",
        "torch/_ops.py",
        "torch/_utils_internal.py",
      ],
      sources =
        module === "torch_directml"
          ? ["torch_directml/__init__.py"]
          : [
              "torchvision/__init__.py",
              "torchvision/extension.py",
              "torchvision/_internally_replaced_utils.py",
            ];
    for (const path of [...torchFiles, ...sources]) await f.bootstrap(path);
    await f.put(binary, fixturePe64([{ name: "c10.dll", kind: "import" }]));
    const own = sources.map((path) => site + path);
    if (module === "torch_directml") {
      const path = `${site}torch_directml/DirectML.dll`;
      await f.put(path, fixturePe64());
      own.push(path);
    }
    await f.wheel(module, [binary, ...own]);
    await f.wheel(
      "torch",
      torchFiles.map((path) => site + path),
    );
    await f.put(`${site}unrelated/lib/c10.dll`, fixturePe64());
    await f.wheel("unrelated", [`${site}unrelated/lib/c10.dll`]);
    await f.put("runtime/python/c10.dll", fixturePe64());
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "wheel ownership/bootstrap",
    );
  },
);
it("does not grant another wheel Torch's private directory merely because it imports the same filename", async () => {
  const f = await fixture(),
    site = "runtime/python/Lib/site-packages/",
    binary = `${site}unrelated/native.pyd`,
    loader = `${site}torch/__init__.py`,
    dependency = `${site}torch/lib/c10.dll`;
  await f.bootstrap("torch/__init__.py");
  await f.put(binary, fixturePe64([{ name: "c10.dll", kind: "import" }]));
  await f.put(dependency, fixturePe64());
  await f.wheel("unrelated", [binary]);
  await f.wheel("torch", [loader, dependency]);
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "missing or ambiguous",
  );
});
it.each(["torch-dll-record", "importer-record", "torch-bootstrap-owner"])(
  "rejects altered %s provenance on the explicit DirectML→Torch edge",
  async (changed) => {
    const f = await fixture(),
      site = "runtime/python/Lib/site-packages/",
      binary = `${site}torch_directml_native.pyd`,
      library = `${site}torch/lib/c10.dll`,
      directml = `${site}torch_directml/DirectML.dll`;
    const torchFiles = [
      "torch/__init__.py",
      "torch/_ops.py",
      "torch/_utils_internal.py",
    ];
    for (const path of [...torchFiles, "torch_directml/__init__.py"])
      await f.bootstrap(path);
    await f.put(binary, fixturePe64([{ name: "c10.dll", kind: "import" }]));
    await f.put(library, fixturePe64());
    await f.put(directml, fixturePe64());
    const importerRecord = await f.wheel("torch_directml", [
      `${site}torch_directml/__init__.py`,
      binary,
      directml,
    ]);
    const torchRecord = await f.wheel("torch", [
      ...torchFiles.map((path) => site + path),
      library,
    ]);
    if (changed === "torch-bootstrap-owner")
      await f.wheel("unrelated", [`${site}torch/__init__.py`]);
    else {
      const record =
          changed === "torch-dll-record" ? torchRecord : importerRecord,
        target =
          changed === "torch-dll-record"
            ? "torch/lib/c10.dll"
            : "torch_directml_native.pyd";
      const text = await readFile(join(f.root, record.path), "utf8");
      await f.put(
        record.path,
        text
          .split("\r\n")
          .map((line) =>
            line.startsWith(target + ",")
              ? line.replace(
                  /sha256=[A-Za-z0-9_-]{43}/u,
                  "sha256=" + Buffer.alloc(32).toString("base64url"),
                )
              : line,
          )
          .join("\r\n"),
      );
    }
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "wheel ownership/bootstrap",
    );
  },
);
it("binds TorchDirectML to its explicit own-DLL preload through the full pinned Torch load_library chain", async () => {
  const f = await fixture(),
    site = "runtime/python/Lib/site-packages/",
    binary = `${site}torch_directml_native.cp312-win_amd64.pyd`,
    dependency = `${site}torch_directml/DirectML.dll`;
  const torchFiles = [
    "torch/__init__.py",
    "torch/_ops.py",
    "torch/_utils_internal.py",
  ];
  for (const path of [...torchFiles, "torch_directml/__init__.py"])
    await f.bootstrap(path);
  await f.put(binary, fixturePe64([{ name: "DirectML.dll", kind: "delay" }]));
  await f.put(dependency, fixturePe64());
  await f.wheel("torch_directml", [
    `${site}torch_directml/__init__.py`,
    binary,
    dependency,
  ]);
  await f.wheel(
    "torch",
    torchFiles.map((path) => site + path),
  );
  await f.put(`${site}onnxruntime/capi/DirectML.dll`, fixturePe64());
  await f.wheel("onnxruntime_directml", [
    `${site}onnxruntime/capi/DirectML.dll`,
  ]);
  const audit = await auditWindowsConsumerDlls(f.root, f.files);
  expect(audit.imports[0]!.path).toBe(dependency);
  expect(audit.imports[0]!.wheel!.bootstrap.map((pin) => pin.path)).toEqual([
    `${site}torch_directml/__init__.py`,
    ...torchFiles.map((path) => site + path),
  ]);
});
it.each(["torch/__init__.py", "torch/_ops.py", "torch/_utils_internal.py"])(
  "rejects a changed %s in the indirect TorchDirectML preload chain",
  async (changed) => {
    const f = await fixture(),
      site = "runtime/python/Lib/site-packages/",
      binary = `${site}torch_directml_native.pyd`,
      dependency = `${site}torch_directml/DirectML.dll`;
    const torchFiles = [
      "torch/__init__.py",
      "torch/_ops.py",
      "torch/_utils_internal.py",
    ];
    for (const path of [...torchFiles, "torch_directml/__init__.py"])
      await f.bootstrap(path);
    const path = site + changed;
    await f.put(
      path,
      Buffer.concat([
        await readFile(join(f.root, path)),
        Buffer.from("\n# modified\n"),
      ]),
    );
    await f.put(
      binary,
      fixturePe64([{ name: "directml.dll", kind: "import" }]),
    );
    await f.put(dependency, fixturePe64());
    await f.wheel("torch_directml", [
      `${site}torch_directml/__init__.py`,
      binary,
      dependency,
    ]);
    await f.wheel(
      "torch",
      torchFiles.map((path) => site + path),
    );
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "wheel ownership/bootstrap",
    );
  },
);
it("requires the explicit own DirectML file even when ORT supplies a unique DLL with identical bytes", async () => {
  const f = await fixture(),
    site = "runtime/python/Lib/site-packages/",
    binary = `${site}torch_directml_native.pyd`;
  const torchFiles = [
    "torch/__init__.py",
    "torch/_ops.py",
    "torch/_utils_internal.py",
  ];
  for (const path of [...torchFiles, "torch_directml/__init__.py"])
    await f.bootstrap(path);
  await f.put(binary, fixturePe64([{ name: "directml.dll", kind: "import" }]));
  await f.wheel("torch_directml", [
    `${site}torch_directml/__init__.py`,
    binary,
  ]);
  await f.wheel(
    "torch",
    torchFiles.map((path) => site + path),
  );
  await f.put(`${site}onnxruntime/capi/DirectML.dll`, fixturePe64());
  await f.wheel("onnxruntime_directml", [
    `${site}onnxruntime/capi/DirectML.dll`,
  ]);
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "wheel ownership/bootstrap",
  );
});
it("denies differently cased RECORD ownership aliases under Windows filename semantics", async () => {
  const f = await fixture(),
    site = "runtime/python/Lib/site-packages/",
    binary = `${site}package/native.pyd`,
    dependency = `${site}package/private.dll`;
  await f.put(binary, fixturePe64([{ name: "private.dll", kind: "import" }]));
  await f.put(dependency, fixturePe64());
  await f.wheel("package", [binary, dependency]);
  const data = await readFile(join(f.root, dependency));
  await f.put(
    `${site}another-1.0.dist-info/RECORD`,
    `package/PRIVATE.DLL,sha256=${createHash("sha256").update(data).digest("base64url")},${data.length}\n`,
  );
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "wheel ownership/bootstrap",
  );
});
it("binds ordinary Torch and functorch extensions to only their own fully pinned torch/lib scope", async () => {
  const f = await fixture(),
    site = "runtime/python/Lib/site-packages/",
    binary = `${site}torch/_C.cp312-win_amd64.pyd`,
    functorch = `${site}functorch/_C.cp312-win_amd64.pyd`,
    dependency = `${site}torch/lib/torch_python.dll`,
    loader = `${site}torch/__init__.py`;
  await f.bootstrap("torch/__init__.py");
  await f.put(
    binary,
    fixturePe64([{ name: "torch_python.dll", kind: "import" }]),
  );
  await f.put(
    functorch,
    fixturePe64([{ name: "torch_python.dll", kind: "delay" }]),
  );
  await f.put(dependency, fixturePe64());
  await f.wheel("torch", [loader, binary, functorch, dependency]);
  await f.put(`${site}another/lib/torch_python.dll`, fixturePe64());
  await f.wheel("another", [`${site}another/lib/torch_python.dll`]);
  expect(
    (await auditWindowsConsumerDlls(f.root, f.files)).imports.map(
      (row) => row.path,
    ),
  ).toEqual([dependency, dependency]);
});
it("allows a bounded unused static-library RECORD declaration without reading or treating it as a DLL dependency", async () => {
  const f = await fixture(),
    site = "runtime/python/Lib/site-packages/",
    binary = `${site}package/native.pyd`,
    dependency = `${site}package/private.dll`;
  await f.put(binary, fixturePe64([{ name: "private.dll", kind: "import" }]));
  await f.put(dependency, fixturePe64());
  const record = await f.wheel("package", [binary, dependency]);
  const text = await readFile(join(f.root, record.path), "utf8");
  await f.put(
    record.path,
    `${text}package/unused-static.lib,sha256=${Buffer.alloc(32).toString("base64url")},647431256\n`,
  );
  expect(
    (await auditWindowsConsumerDlls(f.root, f.files)).imports[0]!.path,
  ).toBe(dependency);
  await f.put(
    record.path,
    `${text}package/oversized-static.lib,sha256=${Buffer.alloc(32).toString("base64url")},2147483649\n`,
  );
  await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
    "wheel ownership/bootstrap",
  );
});
it.each(["sklearn", "torch_directml"])(
  "rejects a missing %s full-path preload even if a root-directory replacement exists",
  async (module) => {
    const f = await fixture(),
      site = "runtime/python/Lib/site-packages/";
    if (module === "sklearn") {
      const binary = `${site}sklearn/native.pyd`,
        local = `${site}sklearn/.libs/msvcp140.dll`;
      await f.bootstrap("sklearn/__init__.py");
      await f.bootstrap("sklearn/_distributor_init.py");
      await f.put(
        binary,
        fixturePe64([{ name: "msvcp140.dll", kind: "import" }]),
      );
      await f.put(local, fixturePe64());
      await f.put("runtime/python/vcomp140.dll", fixturePe64());
      await f.wheel("scikit_learn", [
        `${site}sklearn/__init__.py`,
        `${site}sklearn/_distributor_init.py`,
        binary,
        local,
      ]);
    } else {
      const binary = `${site}torch_directml_native.pyd`,
        torchFiles = [
          "torch/__init__.py",
          "torch/_ops.py",
          "torch/_utils_internal.py",
        ];
      for (const path of [...torchFiles, "torch_directml/__init__.py"])
        await f.bootstrap(path);
      await f.put(
        binary,
        fixturePe64([{ name: "directml.dll", kind: "delay" }]),
      );
      await f.put("runtime/python/DirectML.dll", fixturePe64());
      await f.wheel(
        "torch",
        torchFiles.map((path) => site + path),
      );
      await f.wheel("torch_directml", [
        binary,
        `${site}torch_directml/__init__.py`,
      ]);
    }
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "wheel ownership/bootstrap",
    );
  },
);
it.each([
  "msvcp140d-a4c2229bdc2a2a630acdc095b4d86008.dll",
  "vcruntime140_1d.dll",
])(
  "keeps debug CRT %s denied despite possible renamed private presence",
  async (name) => {
    const f = await fixture();
    await f.put(`runtime/python/${name}`, fixturePe64());
    await expect(auditWindowsConsumerDlls(f.root, f.files)).rejects.toThrow(
      "debug VC/UCRT",
    );
  },
);
