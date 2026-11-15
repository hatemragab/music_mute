import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  link,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  buildStoreAgentNotices,
  copyStoreWorkerAgentInputs,
  parseStoreAgentBuildInputsBytes,
  stageStoreAgentNotices,
  verifyStoreAgentNotices,
  STORE_AGENT_BUILD_INPUTS,
  STORE_AGENT_LICENSES,
  STORE_AGENT_NOTICE_PATH,
  STORE_AGENT_ROLES,
  STORE_WORKER_AGENT_ROLES,
} from "../packaging/store/agent-notices.js";

const component = resolve(import.meta.dirname, ".."),
  hash = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex"),
  encode = (value: unknown) => Buffer.from(JSON.stringify(value));
async function fixture(withThirdParty = true) {
  const folder = await realpath(
      await mkdtemp(join(tmpdir(), "store-agent-notices-")),
    ),
    root = join(folder, "repository/windows-desktop"),
    payload = join(folder, "payload"),
    thirdParty = withThirdParty
      ? [
          "node_modules/electron/index.js",
          "node_modules/pend/index.js",
          "node_modules/yauzl/crc32.js",
          "node_modules/yauzl/fd-slicer.js",
          "node_modules/yauzl/index.js",
        ]
      : [],
    sources: { path: string; bytes: number; sha256: string }[] = [],
    byPath = new Map<string, Buffer>();
  await mkdir(root, { recursive: true });
  await mkdir(payload);
  const save = async (path: string, bytes: Uint8Array) => {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: "wx" });
  };
  for (const path of [
    ...thirdParty,
    ...STORE_AGENT_ROLES.map(
      (role) =>
        `src/agent/${role === "browser-host" ? "browser-host-cli" : role}.ts`,
    ),
  ].sort()) {
    const bytes = Buffer.from(`// receiving fixture only: ${path}\n`);
    byPath.set(path, bytes);
    sources.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    await save(path, bytes);
  }
  const agents = [];
  for (const role of STORE_AGENT_ROLES) {
    const file = `${role}.cjs`,
      entry = `src/agent/${role === "browser-host" ? "browser-host-cli" : role}.ts`,
      raw = Buffer.from(`// receiving output fixture only: ${role}\n`),
      paths = [
        ...thirdParty.filter(
          (path) =>
            role === "browser-host" ||
            path !== "node_modules/electron/index.js",
        ),
        entry,
      ];
    await save(`dist/agent/${file}`, raw);
    agents.push({
      role,
      file,
      bytes: raw.length,
      sha256: hash(raw),
      compileDefinitions: {
        __MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__: '"store-v1"',
        ...(role !== "browser-host"
          ? { "process.versions.electron": "undefined" }
          : {}),
      },
      graph: {
        inputs: Object.fromEntries(
          paths.map((path) => [
            path,
            { bytes: byPath.get(path)!.length, imports: [], format: "esm" },
          ]),
        ),
        outputs: {
          [`dist/agent/${file}`]: {
            imports: [],
            exports: [],
            entryPoint: entry,
            inputs: Object.fromEntries(
              paths.map((path) => [path, { bytesInOutput: 1 }]),
            ),
            bytes: raw.length,
          },
        },
      },
    });
  }
  const value = {
    version: 1,
    purpose: "store-agent-compiled-inputs",
    authorityProfile: "store-v1",
    compiler: { name: "esbuild", version: "0.28.2" },
    sources,
    agents,
  };
  await save(STORE_AGENT_BUILD_INPUTS, encode(value));
  const packages: Record<string, unknown> = {};
  for (const pin of STORE_AGENT_LICENSES) {
    packages[`node_modules/${pin.name}`] = {
      version: pin.version,
      license: "MIT",
    };
    for (const file of ["package.json", "LICENSE"])
      await save(
        `node_modules/${pin.name}/${file}`,
        await readFile(join(component, "node_modules", pin.name, file)),
      );
  }
  await save("package-lock.json", encode({ packages }));
  return {
    folder,
    root,
    payload,
    value,
    saveReceipt: () =>
      writeFile(join(root, STORE_AGENT_BUILD_INPUTS), encode(value)),
  };
}
describe("Store Agent graph-bound notices", () => {
  it("compiles separate Store and local-test consumers that reject each other's six-role receipts", async () => {
    const f = await fixture();
    try {
      for (const profile of ["store-v1", "local-test-v1"]) {
        const output = join(f.folder, `${profile}.cjs`);
        await build({
          absWorkingDir: component,
          entryPoints: ["packaging/store/agent-notices.ts"],
          outfile: output,
          bundle: true,
          platform: "node",
          format: "cjs",
          target: "node24",
          define: {
            __MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__: JSON.stringify(profile),
          },
        });
        const consumer = createRequire(import.meta.url)(output) as {
            parseStoreAgentBuildInputsBytes: typeof parseStoreAgentBuildInputsBytes;
          },
          current = JSON.parse(
            encode(f.value).toString("utf8"),
          ) as typeof f.value;
        current.authorityProfile = profile;
        for (const agent of current.agents)
          agent.compileDefinitions.__MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__ =
            JSON.stringify(profile);
        expect(
          consumer.parseStoreAgentBuildInputsBytes(encode(current))
            .authorityProfile,
        ).toBe(profile);
        const foreign = {
          ...current,
          authorityProfile:
            profile === "store-v1" ? "local-test-v1" : "store-v1",
        };
        expect(() =>
          consumer.parseStoreAgentBuildInputsBytes(encode(foreign)),
        ).toThrow("STORE_AGENT_NOTICE_INVALID");
        const legacy = JSON.parse(encode(f.value).toString("utf8")) as Record<
          string,
          unknown
        >;
        delete legacy.authorityProfile;
        for (const agent of legacy.agents as Record<string, unknown>[])
          delete agent.compileDefinitions;
        if (profile === "store-v1")
          expect(
            consumer.parseStoreAgentBuildInputsBytes(encode(legacy))
              .authorityProfile,
          ).toBe(profile);
        else
          expect(() =>
            consumer.parseStoreAgentBuildInputsBytes(encode(legacy)),
          ).toThrow("STORE_AGENT_NOTICE_INVALID");
      }
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  });
  it("binds the fixed compiler authority and preserves only strict Store legacy receipts", async () => {
    const f = await fixture();
    try {
      const original = encode(f.value);
      expect(parseStoreAgentBuildInputsBytes(original).authorityProfile).toBe(
        "store-v1",
      );
      for (const profile of ["local-test-v1", "invalid", null])
        expect(() =>
          parseStoreAgentBuildInputsBytes(
            encode({ ...f.value, authorityProfile: profile }),
          ),
        ).toThrow("STORE_AGENT_NOTICE_INVALID");
      for (const index of [0, 5]) {
        const wrong = JSON.parse(original.toString("utf8")) as typeof f.value;
        wrong.agents[
          index
        ]!.compileDefinitions.__MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__ =
          '"local-test-v1"';
        expect(() => parseStoreAgentBuildInputsBytes(encode(wrong))).toThrow(
          "STORE_AGENT_NOTICE_INVALID",
        );
        Object.assign(wrong.agents[index]!.compileDefinitions, {
          OTHER_DEFINITION: "true",
        });
        expect(() => parseStoreAgentBuildInputsBytes(encode(wrong))).toThrow(
          "STORE_AGENT_NOTICE_INVALID",
        );
      }
      const legacy = JSON.parse(original.toString("utf8")) as Record<
        string,
        unknown
      >;
      delete legacy.authorityProfile;
      for (const agent of legacy.agents as Record<string, unknown>[])
        delete agent.compileDefinitions;
      expect(
        parseStoreAgentBuildInputsBytes(encode(legacy)).authorityProfile,
      ).toBe("store-v1");
      legacy.authorityProfile = "store-v1";
      expect(() => parseStoreAgentBuildInputsBytes(encode(legacy))).toThrow(
        "STORE_AGENT_NOTICE_INVALID",
      );
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  });
  it("accepts an actual zero-third-party graph without requiring or inventing unused dependency licenses", async () => {
    const f = await fixture(false);
    try {
      await rm(join(f.root, "node_modules"), { recursive: true });
      await writeFile(
        join(f.root, "package-lock.json"),
        encode({ packages: { "": { name: "receiving-fixture" } } }),
      );
      const notices = await buildStoreAgentNotices(f.root);
      expect(notices.toString()).toContain("No third-party JavaScript modules");
      expect(notices.toString()).not.toContain("electron@");
      expect(notices.toString()).not.toContain("MIT License");
      await stageStoreAgentNotices(f.payload, f.root);
      await verifyStoreAgentNotices(f.payload, f.root);
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  });
  it("rejects the dormant development Electron resolver in any Worker role without allowing an external shim", async () => {
    const f = await fixture();
    try {
      const node = f.value.agents[0]!,
        name = "node_modules/electron/index.js",
        browser = f.value.agents.at(-1)!;
      node.graph.inputs[name] = browser.graph.inputs[name]!;
      await f.saveReceipt();
      await expect(buildStoreAgentNotices(f.root)).rejects.toThrow(
        "STORE_AGENT_NOTICE_INVALID",
      );
      delete node.graph.inputs[name];
      Object.values(node.graph.outputs)[0]!.imports.push({
        path: "electron",
        kind: "dynamic-import",
        external: true,
      } as never);
      await f.saveReceipt();
      await expect(buildStoreAgentNotices(f.root)).rejects.toThrow(
        "STORE_AGENT_NOTICE_INVALID",
      );
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  });
  it("projects only the five fixed Worker-owned agents from the six-role compiler inputs", async () => {
    const f = await fixture();
    try {
      const destination = join(f.folder, "worker-agents");
      await copyStoreWorkerAgentInputs(f.root, destination);
      expect((await readdir(destination)).sort()).toEqual(
        STORE_WORKER_AGENT_ROLES.map((role) => `${role}.cjs`).sort(),
      );
      for (const file of await readdir(destination))
        expect(await readFile(join(destination, file))).toEqual(
          await readFile(join(f.root, "dist/agent", file)),
        );
      expect(
        await readFile(join(f.root, "dist/agent/browser-host.cjs")),
      ).toBeDefined();
      await expect(
        copyStoreWorkerAgentInputs(f.root, destination),
      ).rejects.toThrow("STORE_AGENT_NOTICE_INVALID");
      await expect(
        copyStoreWorkerAgentInputs(
          f.root,
          join(f.root, "unexpected-agent-copy"),
        ),
      ).rejects.toThrow("STORE_AGENT_NOTICE_INVALID");
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  });
  it("stages exact existing dependency license texts and verifies the copied bytes without granting runtime authority", async () => {
    const f = await fixture();
    try {
      const parsed = parseStoreAgentBuildInputsBytes(encode(f.value));
      expect(parsed.agents).toHaveLength(6);
      expect(parsed).not.toHaveProperty("storeExecutionQualified");
      const expected = await buildStoreAgentNotices(f.root);
      for (const pin of STORE_AGENT_LICENSES.filter(
        (pin) => pin.name !== "electron",
      ))
        expect(expected.toString("utf8")).toContain(
          `${pin.name}@${pin.version}`,
        );
      expect(expected.toString("utf8")).not.toContain("electron@44.7.0");
      await stageStoreAgentNotices(f.payload, f.root);
      await verifyStoreAgentNotices(f.payload, f.root);
      expect(await readFile(join(f.payload, STORE_AGENT_NOTICE_PATH))).toEqual(
        expected,
      );
      await expect(
        stageStoreAgentNotices(f.payload, f.root),
      ).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  });
  it("rejects same-length current source and compiled-output substitutions", async () => {
    const f = await fixture();
    try {
      const source = f.value.sources[0]!,
        path = join(f.root, source.path),
        raw = await readFile(path);
      raw[0] = 33;
      await writeFile(path, raw);
      await expect(buildStoreAgentNotices(f.root)).rejects.toThrow(
        "STORE_AGENT_NOTICE_INVALID",
      );
      await writeFile(
        path,
        Buffer.from(`// receiving fixture only: ${source.path}\n`),
      );
      const out = join(f.root, "dist/agent/session-agent.cjs"),
        bytes = await readFile(out);
      bytes[0] = 33;
      await writeFile(out, bytes);
      await expect(buildStoreAgentNotices(f.root)).rejects.toThrow(
        "STORE_AGENT_NOTICE_INVALID",
      );
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  });
  it("rejects omitted, changed or independently updated package notices", async () => {
    const f = await fixture();
    try {
      const license = join(f.root, "node_modules/pend/LICENSE"),
        original = await readFile(license);
      await writeFile(license, Buffer.from("edited license"));
      await expect(buildStoreAgentNotices(f.root)).rejects.toThrow(
        "STORE_AGENT_NOTICE_INVALID",
      );
      await writeFile(license, original);
      const manifest = join(f.root, "node_modules/pend/package.json"),
        value = JSON.parse((await readFile(manifest)).toString("utf8")) as {
          version: string;
        };
      value.version = "1.2.1";
      await writeFile(manifest, encode(value));
      await expect(buildStoreAgentNotices(f.root)).rejects.toThrow(
        "STORE_AGENT_NOTICE_INVALID",
      );
      await rm(license);
      await expect(buildStoreAgentNotices(f.root)).rejects.toThrow();
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  });
  it("rejects foreign runtime dependencies and unsorted, extra or duplicate compiler records", async () => {
    const f = await fixture();
    try {
      const original = encode(f.value);
      f.value.agents[0]!.graph.inputs["node_modules/foreign/index.js"] = {
        bytes: 1,
        imports: [],
        format: "esm",
      };
      expect(() => parseStoreAgentBuildInputsBytes(encode(f.value))).toThrow(
        "STORE_AGENT_NOTICE_INVALID",
      );
      const value = JSON.parse(original.toString("utf8")) as typeof f.value;
      value.agents[1]!.role = value.agents[0]!.role;
      expect(() => parseStoreAgentBuildInputsBytes(encode(value))).toThrow();
      const other = JSON.parse(original.toString("utf8")) as typeof f.value;
      other.sources.reverse();
      expect(() => parseStoreAgentBuildInputsBytes(encode(other))).toThrow();
      expect(() =>
        parseStoreAgentBuildInputsBytes(
          Buffer.from(
            original
              .toString("utf8")
              .replace('"version":1', '"version":1,"\\u0076ersion":1'),
          ),
        ),
      ).toThrow("STORE_BUILD_JSON_INVALID");
      expect(() =>
        parseStoreAgentBuildInputsBytes(
          encode({ ...f.value, paidSigning: true }),
        ),
      ).toThrow();
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  });
  it("rejects source-path authority overrides, missing graphs and unknown compiler versions", async () => {
    const f = await fixture();
    try {
      const original = encode(f.value);
      for (const path of [
        "C:/SDK/tool.exe",
        "../../private.py",
        "../worker/../../.env",
        "node_modules/new-tool/entry.js",
      ]) {
        const value = JSON.parse(original.toString("utf8")) as typeof f.value;
        value.sources[0]!.path = path;
        expect(() => parseStoreAgentBuildInputsBytes(encode(value))).toThrow();
      }
      expect(() =>
        parseStoreAgentBuildInputsBytes(
          encode({ ...f.value, agents: f.value.agents.slice(0, 5) }),
        ),
      ).toThrow();
      expect(() =>
        parseStoreAgentBuildInputsBytes(
          encode({
            ...f.value,
            compiler: { name: "esbuild", version: "0.28.3" },
          }),
        ),
      ).toThrow();
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  });
  it("rejects a copied notice changed after staging", async () => {
    const f = await fixture();
    try {
      await stageStoreAgentNotices(f.payload, f.root);
      await writeFile(
        join(f.payload, STORE_AGENT_NOTICE_PATH),
        "stale notice\n",
      );
      await expect(verifyStoreAgentNotices(f.payload, f.root)).rejects.toThrow(
        "STORE_AGENT_NOTICE_INVALID",
      );
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  });
  it("rejects aliases to source code and hard-linked dependency notices", async () => {
    const f = await fixture();
    try {
      const path = join(f.root, f.value.sources[0]!.path),
        backup = join(f.folder, "source-backup.txt"),
        raw = await readFile(path);
      await writeFile(backup, raw, { flag: "wx" });
      await rm(path);
      await symlink(backup, path);
      await expect(buildStoreAgentNotices(f.root)).rejects.toThrow();
      await rm(path);
      await writeFile(path, raw, { flag: "wx" });
      const license = join(f.root, "node_modules/pend/LICENSE"),
        copy = join(f.folder, "license-alias.txt");
      await link(license, copy);
      await expect(buildStoreAgentNotices(f.root)).rejects.toThrow(
        "STORE_INVENTORY_INVALID",
      );
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  });
  it("rejects emitted external code imports, invalid UTF-8 and oversized compiler receipts", async () => {
    const f = await fixture();
    try {
      const agent = f.value.agents[0]!,
        output = Object.values(agent.graph.outputs)[0]!;
      const edited = JSON.parse(JSON.stringify(f.value)) as typeof f.value;
      const row = Object.values(edited.agents[0]!.graph.outputs)[0]!;
      Object.assign(row, {
        imports: [
          {
            path: "./downloaded-code.js",
            kind: "require-call",
            external: true,
          },
        ],
      });
      expect(() => parseStoreAgentBuildInputsBytes(encode(edited))).toThrow(
        "STORE_AGENT_NOTICE_INVALID",
      );
      expect(output.imports).toEqual([]);
      expect(() =>
        parseStoreAgentBuildInputsBytes(Buffer.from([0xff])),
      ).toThrow();
      expect(() =>
        parseStoreAgentBuildInputsBytes(Buffer.alloc(4 * 1024 ** 2 + 1)),
      ).toThrow("STORE_BUILD_JSON_INVALID");
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  });
});
