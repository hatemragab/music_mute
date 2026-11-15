import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import {
  AGENT_BUILD_ROLES,
  WORKER_NODE_AGENT_ROLES,
  agentBuildOptions,
  packageBuildOptions,
  packageBuildProfileFromArguments,
  createAgentInputCapture,
  writeAgentBuildOutputs,
  writeAgentBuildInputs,
} from "./agent-build-inputs.mjs";

// Real compiler tests on synthetic source only; no installed Store or native
// actor/GPU success is implied by these build-material receipts.
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agent-compile-inputs-")),
  );
  for (const role of AGENT_BUILD_ROLES) {
    const path = join(
      root,
      `src/agent/${role === "browser-host" ? "browser-host-cli" : role}.ts`,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `export async function open() {
      if (process.versions.electron !== undefined) {
        const { app } = await import('electron'); return app.marker;
      } else throw new Error('NODE_GUI_DENIED');
    }
    export const role=${JSON.stringify(role)};
    export const authorityProfile=__MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__;
    `,
    );
  }
  const library = join(root, "node_modules/electron");
  await mkdir(library, { recursive: true });
  await writeFile(
    join(library, "package.json"),
    JSON.stringify({
      name: "electron",
      version: "44.7.0",
      main: "index.js",
      type: "module",
    }),
  );
  await writeFile(
    join(library, "index.js"),
    "export const app={marker:'synthetic-gui-module'};\n",
  );
  const capture = createAgentInputCapture(root);
  const compile = async (
    optionsFor = agentBuildOptions,
    currentCapture = capture,
  ) => {
    const results = await Promise.all(
      AGENT_BUILD_ROLES.map((role) =>
        build({
          absWorkingDir: root,
          bundle: true,
          metafile: true,
          sourcemap: true,
          write: false,
          platform: "node",
          format: "cjs",
          target: "node24",
          entryPoints: [
            `src/agent/${role === "browser-host" ? "browser-host-cli" : role}.ts`,
          ],
          outfile: `dist/agent/${role}.cjs`,
          plugins: [currentCapture.plugin],
          ...optionsFor(role),
        }),
      ),
    );
    await writeAgentBuildOutputs(root, results);
    return results;
  };
  return { root, capture, compile };
}
test("only the five fixed Worker compiler roles get the literal Node definition", () => {
  assert.equal(WORKER_NODE_AGENT_ROLES.length, 5);
  for (const role of WORKER_NODE_AGENT_ROLES)
    assert.deepEqual(agentBuildOptions(role), {
      define: {
        __MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__: '"store-v1"',
        "process.versions.electron": "undefined",
      },
    });
  assert.deepEqual(agentBuildOptions("browser-host"), packageBuildOptions());
  assert.throws(() => agentBuildOptions("main"), /AGENT_BUILD_INPUT_CHANGED/);
});
test("only the explicit single local-test argument changes the fixed compiler authority", () => {
  assert.equal(packageBuildProfileFromArguments([]), "store-v1");
  assert.equal(
    packageBuildProfileFromArguments(["--local-test-v1"]),
    "local-test-v1",
  );
  for (const args of [
    ["--store-v1"],
    ["--local-test-v1", "--local-test-v1"],
    ["--define=x"],
    ["local-test-v1"],
    null,
  ])
    assert.throws(
      () => packageBuildProfileFromArguments(args),
      /AGENT_BUILD_INPUT_CHANGED/,
    );
  for (const profile of ["dev", "", null, {}])
    assert.throws(
      () => packageBuildOptions(profile),
      /AGENT_BUILD_INPUT_CHANGED/,
    );
});
test("both profiles compile all six roles with exact pinned definitions and reject relabelled or missing profile definitions", async () => {
  const f = await fixture();
  try {
    for (const authorityProfile of ["store-v1", "local-test-v1"]) {
      const capture = createAgentInputCapture(f.root),
        results = await f.compile(
          (role) => agentBuildOptions(role, authorityProfile),
          capture,
        ),
        receipt = JSON.parse(
          await writeAgentBuildInputs(
            f.root,
            results,
            capture,
            authorityProfile,
          ),
        );
      assert.equal(receipt.authorityProfile, authorityProfile);
      for (const [index, role] of AGENT_BUILD_ROLES.entries()) {
        assert.deepEqual(
          receipt.agents[index].compileDefinitions,
          agentBuildOptions(role, authorityProfile).define,
        );
        const code = await readFile(
          join(f.root, `dist/agent/${role}.cjs`),
          "utf8",
        );
        assert.ok(
          code.includes(
            `var authorityProfile = ${JSON.stringify(authorityProfile)}`,
          ),
        );
        assert.ok(!code.includes("__MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__"));
      }
      await assert.rejects(
        writeAgentBuildInputs(
          f.root,
          results,
          capture,
          authorityProfile === "store-v1" ? "local-test-v1" : "store-v1",
        ),
        /AGENT_BUILD_INPUT_CHANGED/,
      );
    }
    const capture = createAgentInputCapture(f.root),
      missing = await f.compile(
        (role) => ({
          define:
            role === "browser-host"
              ? {}
              : { "process.versions.electron": "undefined" },
        }),
        capture,
      );
    await assert.rejects(
      writeAgentBuildInputs(f.root, missing, capture),
      /AGENT_BUILD_INPUT_CHANGED/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("actual compiler removes the GUI dependency for Worker roles and writes six exact current source/output receipts", async () => {
  const f = await fixture();
  try {
    const results = await f.compile(),
      raw = await writeAgentBuildInputs(f.root, results, f.capture),
      receipt = JSON.parse(raw);
    assert.equal(receipt.agents.length, 6);
    for (const [index, role] of AGENT_BUILD_ROLES.entries()) {
      const graph = results[index].metafile,
        output = await readFile(join(f.root, `dist/agent/${role}.cjs`));
      assert.equal(
        Object.hasOwn(graph.inputs, "node_modules/electron/index.js"),
        role === "browser-host",
      );
      assert.equal(
        output.includes(Buffer.from("synthetic-gui-module")),
        role === "browser-host",
      );
      assert.equal(receipt.agents[index].bytes, output.length);
      assert.equal(
        receipt.agents[index].sha256,
        createHash("sha256").update(output).digest("hex"),
      );
      assert.deepEqual(Object.keys(receipt.agents[index].graph.outputs), [
        `dist/agent/${role}.cjs`,
      ]);
    }
    for (const pin of receipt.sources) {
      const raw = await readFile(join(f.root, pin.path));
      assert.equal(pin.bytes, raw.length);
      assert.equal(pin.sha256, createHash("sha256").update(raw).digest("hex"));
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("rejects same-length source drift after the exact bytes were parsed by the compiler", async () => {
  const f = await fixture();
  try {
    const results = await f.compile(),
      path = join(f.root, "src/agent/fleet.ts"),
      original = await readFile(path);
    const changed = Buffer.from(original);
    changed[0] = 32;
    await writeFile(path, changed);
    await assert.rejects(
      writeAgentBuildInputs(f.root, results, f.capture),
      /AGENT_BUILD_INPUT_CHANGED/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("rejects altered compiled bytes and a Worker role that omitted the fixed definition", async () => {
  const f = await fixture();
  try {
    const wrong = await f.compile(() => ({}));
    await assert.rejects(
      writeAgentBuildInputs(f.root, wrong, f.capture),
      /AGENT_BUILD_INPUT_CHANGED/,
    );
    const right = await f.compile(),
      path = join(f.root, "dist/agent/personal.cjs"),
      original = await readFile(path);
    original[0] = 32;
    await writeFile(path, original);
    await assert.rejects(
      writeAgentBuildInputs(f.root, right, f.capture),
      /AGENT_BUILD_INPUT_CHANGED/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("rejects a duplicate compiler output instead of admitting a missing map", async () => {
  const f = await fixture();
  try {
    const results = await f.compile(),
      code = results[0].outputFiles.find((file) => file.path.endsWith(".cjs"));
    results[0] = { ...results[0], outputFiles: [code, code] };
    await assert.rejects(
      writeAgentBuildOutputs(f.root, results),
      /AGENT_BUILD_INPUT_CHANGED/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("requires explicit type-only imports rather than admitting discarded value imports as external code", async () => {
  const f = await fixture();
  try {
    const source = join(f.root, "src/agent/personal.ts"),
      dependency = join(f.root, "src/main/session/gui-only.ts"),
      implicit =
        "import { GuiOnly } from '../main/session/gui-only.js';\n" +
        "export type View = { execution: GuiOnly };\n" +
        "export const role = 'personal';\n";
    await mkdir(dirname(dependency), { recursive: true });
    await writeFile(dependency, "export class GuiOnly {}\n");
    await writeFile(source, implicit);
    const rejected = await f.compile(),
      originalCode = rejected[2].outputFiles.find((file) =>
        file.path.endsWith("personal.cjs"),
      ).contents;
    assert.deepEqual(
      rejected[2].metafile.inputs["src/agent/personal.ts"].imports,
      [
        {
          path: "../main/session/gui-only.js",
          kind: "import-statement",
          external: true,
        },
      ],
    );
    await assert.rejects(
      writeAgentBuildInputs(f.root, rejected, f.capture),
      /AGENT_BUILD_INPUT_CHANGED/,
    );

    await writeFile(source, implicit.replace("import {", "import type {"));
    const currentCapture = createAgentInputCapture(f.root),
      accepted = await f.compile(agentBuildOptions, currentCapture),
      actualCode = accepted[2].outputFiles.find((file) =>
        file.path.endsWith("personal.cjs"),
      ).contents;
    assert.deepEqual(
      accepted[2].metafile.inputs["src/agent/personal.ts"].imports,
      [],
    );
    assert.deepEqual(actualCode, originalCode);
    const receipt = JSON.parse(
      await writeAgentBuildInputs(f.root, accepted, currentCapture),
    );
    assert.equal(receipt.agents.length, 6);
    assert.equal(
      receipt.sources.some(
        (pin) => pin.path === "src/main/session/gui-only.ts",
      ),
      false,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
