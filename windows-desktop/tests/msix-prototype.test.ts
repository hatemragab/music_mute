import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import {
  mkdtemp,
  readFile,
  mkdir,
  writeFile,
  rm,
  realpath,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  prototypeIdentity,
  parsePrototypeIdentity,
  prototypeBuildRelativeDirectory,
  manifestXml,
  configHeader,
  packageNativeManifest,
  productionStoreOriginAllowed,
  UNSIGNED_OID,
  QA_CHROME_PUBLIC_KEY,
  QA_EXTENSION_ID,
  type PrototypeNamespaceCandidate,
} from "../acceptance/msix-prototype/contract.js";

let temp: string;
const qaId = "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
const script = resolve("scripts/msix-prototype.mjs");
const invoke = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
beforeAll(async () => {
  temp = await realpath(
    await mkdtemp(join(tmpdir(), "musicmute-s03-source-test-")),
  );
});
afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});
describe("isolated unsigned MSIX plan", () => {
  it("produces closed x64 identities with unsigned OID and rejects production identity substitution", () => {
    const identity = prototypeIdentity(qaId);
    expect(
      parsePrototypeIdentity(JSON.parse(JSON.stringify(identity))),
    ).toEqual(identity);
    expect(identity.publisher).toContain(UNSIGNED_OID);
    expect(identity.packageName).not.toBe("27120VCHATSDK.MusicMute");
    expect(identity.packageName).not.toBe("27120VCHATSDK.MusicMuteWorker");
    for (const invalid of [
      "",
      "A".repeat(32),
      "a".repeat(31),
      "../" + qaId,
      qaId + '"',
      "a".repeat(32),
      qaId.replace("4", "1"),
      "aaaaaaaaaaaa4aaa0aaaaaaaaaaaaaaa",
    ])
      expect(() => prototypeIdentity(invalid)).toThrow();
    for (const altered of [
      { ...identity, packageName: "27120VCHATSDK.MusicMute" },
      { ...identity, publisher: "CN=VCHATSDK" },
      { ...identity, architecture: "arm64" },
      { ...identity, minVersion: "10.0.19041.0" },
      { ...identity, alias: "cmd.exe" },
      { ...identity, extensionId: "b".repeat(32) },
      { ...identity, extra: true },
    ])
      expect(() => parsePrototypeIdentity(altered)).toThrow();
    expect(manifestXml(identity)).toContain(
      'uap10:RuntimeBehavior="packagedClassicApp"',
    );
    expect(manifestXml(identity)).not.toContain("unvirtualizedResources");
    expect(configHeader(identity)).toContain(identity.packageName);
    const immutable = packageNativeManifest(identity);
    expect(JSON.parse(immutable)).toEqual({
      name: `${identity.hostNames.fixed}.immutable`,
      description: "MusicMute S03 immutable packaged QA host",
      path: identity.hostExecutable,
      type: "stdio",
      allowed_origins: [`chrome-extension://${QA_EXTENSION_ID}/`],
    });
    expect(configHeader(identity)).toContain(
      createHash("sha256").update(immutable).digest("hex"),
    );
    expect(prototypeBuildRelativeDirectory(identity)).toBe(
      "MusicMuteAcceptance-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/native-build",
    );
    expect(
      createPublicKey({
        key: Buffer.from(QA_CHROME_PUBLIC_KEY, "base64"),
        type: "spki",
        format: "der",
      }).asymmetricKeyType,
    ).toBe("rsa");
    expect(QA_EXTENSION_ID).toBe("npkabaieihgikeiahjojlkjjakajjnpa");
  });
  it("None/Developer/Enterprise/System observations cannot masquerade as Store", () => {
    for (const kind of [-1, 0, 1, 2, 4, 5, NaN])
      expect(productionStoreOriginAllowed(kind)).toBe(false);
    expect(productionStoreOriginAllowed(3)).toBe(true);
    // This is a pure policy fixture; no actual Store-signed app is involved.
  });
  it("keeps paired namespace candidate identities closed and distinct with a shared publisher and data cohort", () => {
    const cohort = "bbbbbbbbbbbb4bbb9bbbbbbbbbbbbbbb";
    const candidate: PrototypeNamespaceCandidate = {
      namespaceProfile: "unvirtualized-candidate-v1",
      dataCohort: cohort,
      dataRole: "gui",
    };
    const gui = prototypeIdentity(qaId, candidate);
    const worker = prototypeIdentity("cccccccccccc4cccaccccccccccccccc", {
      ...candidate,
      dataRole: "worker",
    });
    expect(parsePrototypeIdentity(gui)).toEqual(gui);
    expect(parsePrototypeIdentity(worker)).toEqual(worker);
    expect(gui.packageName).not.toBe(worker.packageName);
    expect(gui.alias).not.toBe(worker.alias);
    expect(gui.publisher).toBe(worker.publisher);
    expect(gui.publisher).toContain(cohort);
    expect(manifestXml(gui)).toContain('uap10:RuntimeBehavior="win32App"');
    expect(manifestXml(gui)).not.toContain("packagedClassicApp");
    expect(manifestXml(gui)).not.toContain("EntryPoint=");
    for (const identity of [gui, worker]) {
      const xml = manifestXml(identity);
      expect(xml).toContain(
        '<rescap:Capability Name="unvirtualizedResources" />',
      );
      expect(xml).toContain(
        "<desktop6:RegistryWriteVirtualization>disabled</desktop6:RegistryWriteVirtualization>",
      );
      expect(xml).toContain(
        "<desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>",
      );
      expect(xml).toContain('MinVersion="10.0.19045.0"');
      expect(configHeader(identity)).toContain(
        `#define MM_QA_DATA_COHORT L"${cohort}"`,
      );
      expect(configHeader(identity)).toContain(
        `#define MM_QA_DATA_ROLE L"${identity.dataRole}"`,
      );
    }
    for (const altered of [
      { ...gui, namespaceProfile: "win32-automatic-escape" },
      { ...gui, dataCohort: "../data" },
      { ...gui, dataRole: "fleet" },
      { ...gui, namespaceProfile: undefined },
      { ...gui, dataCohort: undefined },
      { ...gui, dataRole: undefined },
      { ...gui, sharedRoot: "MusicMuteLocal" },
      { ...gui, publisher: prototypeIdentity(qaId).publisher },
    ])
      expect(() => parsePrototypeIdentity(altered)).toThrow();
    for (const invalid of [
      null,
      [],
      {},
      { ...candidate, dataRole: "fleet" },
      { ...candidate, dataCohort: "a".repeat(32) },
      { ...candidate, extra: true },
    ])
      expect(() =>
        prototypeIdentity(qaId, invalid as PrototypeNamespaceCandidate),
      ).toThrow("MSIX_QA_NAMESPACE_CANDIDATE_INVALID");
  });
  it("stages two independent candidate plans through the explicit offline CLI and rejects unsupported roles", async () => {
    const cohort = "dddddddddddd4dddbddddddddddddddd";
    const plans = [];
    for (const role of ["gui", "worker"]) {
      const root = join(temp, `candidate-${role}`);
      const result = invoke("plan-unvirtualized", root, cohort, role);
      expect(result.status, result.stderr).toBe(0);
      const plan = JSON.parse(await readFile(join(root, "plan.json"), "utf8"));
      expect(plan.toolsExecuted).toBe(false);
      expect(plan.deploymentExecuted).toBe(false);
      expect(parsePrototypeIdentity(plan.identity)).toMatchObject({
        namespaceProfile: "unvirtualized-candidate-v1",
        dataRole: role,
        dataCohort: cohort,
      });
      expect(
        await readFile(join(root, "payload/AppxManifest.xml"), "utf8"),
      ).toBe(manifestXml(plan.identity));
      plans.push(plan);
    }
    expect(plans[0].identity.packageName).not.toBe(
      plans[1].identity.packageName,
    );
    expect(plans[0].identity.publisher).toBe(plans[1].identity.publisher);
    expect(
      invoke("plan-unvirtualized", join(temp, "bad-role"), cohort, "fleet")
        .stderr,
    ).toContain("MSIX_QA_NAMESPACE_CANDIDATE_INVALID");
    expect(
      invoke("plan-unvirtualized", join(temp, "bad-cohort"), "../data", "gui")
        .stderr,
    ).toContain("MSIX_QA_NAMESPACE_CANDIDATE_INVALID");
  });
  it("default invocation executes no compiler, deployment or profile mutation", () => {
    const result = invoke();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "plan",
      toolsExecuted: false,
      deploymentExecuted: false,
    });
    expect(invoke("deploy", temp).status).toBe(2);
    expect(invoke("plan", "relative").stderr).toContain("MSIX_QA_PATH_INVALID");
  });
  it("writes actual exclusive native sources, complete assets and bounded manifest", async () => {
    const root = join(temp, "plan");
    const result = invoke("plan", root);
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(await readFile(join(root, "plan.json"), "utf8"));
    expect(plan.toolsExecuted).toBe(false);
    expect(plan.deploymentExecuted).toBe(false);
    expect(plan.sourceFiles).toHaveLength(7);
    expect(plan.buildRelativeDirectory).toBe(
      prototypeBuildRelativeDirectory(plan.identity),
    );
    expect(plan.chromeFixture).toMatchObject({
      directory: "ChromeQA",
      extensionId: QA_EXTENSION_ID,
      profileMutation: false,
      includedInMsixPayload: false,
    });
    expect(plan.chromeFixture.files).toHaveLength(4);
    const immutable = await readFile(
      join(root, "payload/NativeMessagingHost.json"),
    );
    expect(plan.immutableNativeManifest).toEqual({
      bytes: immutable.length,
      sha256: createHash("sha256").update(immutable).digest("hex"),
    });
    expect(immutable.toString("utf8")).toBe(
      packageNativeManifest(plan.identity),
    );
    for (const pin of plan.chromeFixture.files) {
      const bytes = await readFile(join(root, "ChromeQA", pin.path));
      expect(bytes.length).toBe(pin.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(pin.sha256);
    }
    const manifest = JSON.parse(
      await readFile(join(root, "ChromeQA/manifest.json"), "utf8"),
    );
    expect(manifest.permissions).toEqual(["nativeMessaging"]);
    expect(manifest.key).toBe(QA_CHROME_PUBLIC_KEY);
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(parsePrototypeIdentity(plan.identity).installScope).toBe(
      "all-users-executable-unsigned-qa",
    );
    for (const [leaf, size] of [
      ["StoreLogo.png", 50],
      ["Square44x44Logo.png", 44],
      ["Square150x150Logo.png", 150],
    ] as const) {
      const bytes = await readFile(join(root, "payload/Assets", leaf));
      expect(bytes.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(bytes.readUInt32BE(16)).toBe(size);
      expect(bytes.readUInt32BE(20)).toBe(size);
    }
    const before = await readFile(join(root, "plan.json"));
    expect(invoke("plan", root).status).toBe(2);
    expect(await readFile(join(root, "plan.json"))).toEqual(before);
    expect(invoke("deployment-script", root).status).toBe(2);
  });
  it("rejects changed staged sources before examining binaries", async () => {
    const root = join(temp, "changed");
    expect(invoke("plan", root).status).toBe(0);
    await writeFile(join(root, "native/qa-config.hpp"), "tampered");
    expect(invoke("layout", root).stderr).toContain("MSIX_QA_SOURCE_CHANGED");
  });
  it("rejects changed generated Chrome fixture before reading native outputs", async () => {
    const root = join(temp, "chrome-tampered");
    expect(invoke("plan", root).status).toBe(0);
    await writeFile(join(root, "ChromeQA/popup.js"), "foreign code");
    expect(invoke("layout", root).stderr).toContain(
      "MSIX_QA_CHROME_FIXTURE_CHANGED",
    );
  });
  it("rejects changed immutable package host manifest before reading native outputs", async () => {
    const root = join(temp, "package-manifest-tampered");
    expect(invoke("plan", root).status).toBe(0);
    await writeFile(
      join(root, "payload/NativeMessagingHost.json"),
      "foreign manifest",
    );
    expect(invoke("layout", root).stderr).toContain(
      "MSIX_QA_NATIVE_MANIFEST_CHANGED",
    );
  });
  it("rejects x86, foreign identities and link aliases before creating executable payload", async () => {
    const root = join(temp, "pe");
    expect(invoke("plan", root).status).toBe(0);
    const plan = JSON.parse(await readFile(join(root, "plan.json"), "utf8"));
    await writeFile(
      join(root, "native-build-receipt.json"),
      JSON.stringify({
        identity: plan.identity,
        buildRelativeDirectory: plan.buildRelativeDirectory,
        binaries: [],
        steps: ["configure", "compile", "ctest"].map((step) => ({
          step,
          code: 0,
          toolExitCode: 0,
          reason: "completed",
          wholeJobZero: true,
        })),
      }),
    );
    const buildDirectory = join(
      root,
      ...plan.buildRelativeDirectory.split("/"),
      "Release",
    );
    await mkdir(buildDirectory, { recursive: true });
    const pe = Buffer.alloc(2048);
    pe.writeUInt16LE(0x5a4d, 0);
    pe.writeUInt32LE(128, 0x3c);
    pe.writeUInt32LE(0x4550, 128);
    pe.writeUInt16LE(0x14c, 132);
    await writeFile(join(buildDirectory, "MusicMuteMsixProbe.exe"), pe);
    expect(invoke("layout", root).stderr).toContain("MSIX_QA_PE_INVALID");
    pe.writeUInt16LE(0x8664, 132);
    await writeFile(join(buildDirectory, "MusicMuteMsixProbe.exe"), pe);
    expect(invoke("layout", root).stderr).toContain(
      "MSIX_QA_PE_IDENTITY_INVALID",
    );
    Buffer.from(plan.identity.packageName, "utf16le").copy(pe, 512);
    await writeFile(join(buildDirectory, "MusicMuteMsixProbe.exe"), pe);
    await link(
      join(buildDirectory, "MusicMuteMsixProbe.exe"),
      join(temp, "foreign-hardlink.exe"),
    );
    expect(invoke("layout", root).stderr).toContain("MSIX_QA_FILE_INVALID");
  });
});
it("executes actual generated Chrome popup code with bounded fake ports and denies foreign origin/package/correlation", async () => {
  const root = join(temp, "chrome-vm");
  expect(invoke("plan", root).status).toBe(0);
  const plan = JSON.parse(await readFile(join(root, "plan.json"), "utf8"));
  const source = await readFile(join(root, "ChromeQA/popup.js"), "utf8");
  // Source behavior only: this VM is not Chrome/native/MSIX device acceptance.
  const exercise = async (
    extensionId: string,
    kind: number,
    correlate = true,
  ) => {
    type Envelope = {
      protocol_version: number;
      request_id: string;
      type: "HELLO" | "ECHO";
      payload: Record<string, unknown>;
    };
    const sent: Envelope[] = [];
    const connections: string[] = [];
    let listener: (message: unknown) => void = () => {};
    let click: () => Promise<void> = async () => {};
    let disconnects = 0;
    const elements = new Map(
      ["host", "run", "result", "identity"].map((id) => [
        id,
        {
          textContent: "",
          value: "0",
          disabled: false,
          append: () => {},
          addEventListener: (_: string, callback: () => Promise<void>) => {
            if (id === "run") click = callback;
          },
        },
      ]),
    );
    const port = {
      disconnect: () => {
        disconnects++;
      },
      onDisconnect: { addListener: () => {} },
      onMessage: {
        addListener: (callback: typeof listener) => {
          listener = callback;
        },
      },
      postMessage: (request: Envelope) => {
        sent.push(structuredClone(request));
        queueMicrotask(() => {
          const fullName = `${plan.identity.packageName}_1.0.0.0_x64__qa`;
          listener({
            protocol_version: 1,
            request_id: correlate ? request.request_id : randomUUID(),
            type: request.type,
            payload:
              request.type === "ECHO"
                ? { text: request.payload.text, qa_only: true }
                : {
                    ready: false,
                    qa_only: true,
                    observation: {
                      package_name: plan.identity.packageName,
                      package_full_name: fullName,
                      signature_kind: kind,
                      production_store_origin_allowed: false,
                      qa_only: true,
                      elevated: false,
                      session_id: 1,
                      process_package: {
                        has_identity: true,
                        full_name: fullName,
                      },
                    },
                  },
          });
        });
      },
    };
    runInNewContext(source, {
      document: {
        getElementById: (id: string) => elements.get(id),
        createElement: () => ({ value: "", textContent: "" }),
      },
      chrome: {
        runtime: {
          id: extensionId,
          connectNative: (name: string) => {
            connections.push(name);
            return port;
          },
        },
      },
      crypto: { randomUUID },
      performance,
      setTimeout,
      clearTimeout,
    });
    await click();
    return {
      sent,
      connections,
      disconnects,
      result: JSON.parse(elements.get("result")!.textContent),
    };
  };
  const success = await exercise(QA_EXTENSION_ID, 0);
  expect(success.result).toMatchObject({ success: true, qa_only: true });
  expect(success.connections).toEqual([
    `${plan.identity.hostNames.fixed}.direct`,
  ]);
  expect(success.sent.map((request) => request.type)).toEqual([
    "HELLO",
    "ECHO",
  ]);
  expect(success.sent[1]!.payload).toEqual({ text: "مرحبا 🎵" });
  expect(success.disconnects).toBe(1);
  const foreign = await exercise("b".repeat(32), 0);
  expect(foreign.connections).toEqual([]);
  expect(foreign.result).toMatchObject({
    success: false,
    error: "MSIX_QA_CHROME_IDENTITY_INVALID",
  });
  const wrongPackage = await exercise(QA_EXTENSION_ID, 3);
  expect(wrongPackage.sent).toHaveLength(1);
  expect(wrongPackage.result).toMatchObject({
    success: false,
    error: "MSIX_QA_CHROME_PACKAGE_INVALID",
  });
  const wrongCorrelation = await exercise(QA_EXTENSION_ID, 0, false);
  expect(wrongCorrelation.sent).toHaveLength(1);
  expect(wrongCorrelation.result).toMatchObject({
    success: false,
    error: "MSIX_QA_CHROME_RESPONSE_INVALID",
  });
});
it("runs the actual C++ bounded JSON/frame protocol, including Unicode and malformed inputs", () => {
  if (process.platform === "win32") return; // Windows CTest runs this exact target.
  const output = join(temp, "protocol-test");
  execFileSync(
    "/usr/bin/clang++",
    [
      "-std=c++20",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      resolve("../worker/native/windows-consumer"),
      resolve("acceptance/msix-prototype/protocol.test.cpp"),
      "-o",
      output,
    ],
    { timeout: 20_000, maxBuffer: 1024 * 1024 },
  );
  expect(execFileSync(output, [], { encoding: "utf8", timeout: 5000 })).toBe(
    "MSIX_QA_PROTOCOL_PASS\n",
  );
  expect(
    spawnSync(output, ["arbitrary-command"], { encoding: "utf8" }).status,
  ).toBe(2);
});
