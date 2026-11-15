import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { verifyWindowsRelease } from "../../../worker/src/platform/windows/release-manifest.js";
import {
  createConsumerNativeTransport,
  WindowsConsumerNative,
  isCurrentUserSid,
  parseConsumerGpu,
} from "../../../worker/src/platform/windows/consumer-native.js";
import {
  parseQualificationEvidence,
  resolveQualifiedGpuIdentity,
} from "../../../worker/src/enrollment/report-builder.js";
import { HostContext } from "../main/host-context.js";
import {
  hashPrivateFile,
  readPrivateBytes,
  writePrivateAtomic,
} from "../main/prepare/private-files.js";
import { MODEL } from "../../../chrome-extension/src/shared/local-model.js";
import { PREPARATION_FIXTURE } from "../main/prepare/fixture.js";
import {
  assertApprovedPreparationFixture,
  type PreparationChildConfig,
} from "../main/prepare/qualification-runner.js";

import {
  isCloudMediaOperation,
  parseCloudMediaChildConfig,
  runCloudMediaChild,
} from "../main/cloud/media-child.js";
import {
  isSilenceOperation,
  parseSilenceChildConfig,
  runSilenceChild,
} from "../main/player/silence-child.js";
import {
  isAdvancedBenchmarkOperation,
  parseAdvancedBenchmarkConfiguration,
  runAdvancedBenchmarkChild,
} from "../main/fleet/advanced/benchmark-child.js";
import {
  isDiagnosticDoctorOperation,
  parseDiagnosticDoctorConfiguration,
  runDiagnosticDoctorChild,
} from "../main/diagnostics/doctor-child.js";
import {
  isBrowserYoutubeCheckOperation,
  parseBrowserYoutubeCheckConfiguration,
  runBrowserYoutubeCheckChild,
} from "../main/browser/youtube-check-child.js";
import { runStorePreparationChild } from "./store-prepare.js";
import { runStoreCpuPreparationChild } from "./store-cpu-prepare.js";
import { runStoreBenchmarkChild } from "./store-benchmark.js";

const execute = promisify(execFile);
export function parsePreparationChildConfig(
  value: unknown,
): PreparationChildConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PREPARE_CONFIG_INVALID");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== (row.approvedFixture === undefined ? 8 : 9) ||
    row.version !== 1 ||
    !["qualify", "inspect"].includes(String(row.operation)) ||
    typeof row.requestId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      row.requestId,
    ) ||
    !isCurrentUserSid(row.sid) ||
    [row.release, row.manifestSha256, row.helperSha256].some(
      (text) => typeof text !== "string" || !/^[a-f0-9]{64}$/.test(text),
    )
  )
    throw new Error("PREPARE_CONFIG_INVALID");
  if (row.approvedFixture !== undefined)
    assertApprovedPreparationFixture(row.approvedFixture);
  parseConsumerGpu(row.gpu);
  return row as unknown as PreparationChildConfig;
}
/** Fixed, owned qualification entry; no account, worker enrollment or user command execution. */
export async function runPreparationChild(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (argv.length === 1 && argv[0] === "--store-session")
    return runStorePreparationChild(argv);
  if (argv.length === 1 && argv[0] === "--store-cpu")
    return runStoreCpuPreparationChild(argv);
  if (argv.length === 1 && argv[0] === "--store-benchmark")
    return runStoreBenchmarkChild(argv);
  const nonce = process.env.MUSICMUTE_OWNERSHIP_NONCE,
    role = process.env.MUSICMUTE_OWNERSHIP_ROLE;
  delete process.env.MUSICMUTE_OWNERSHIP_NONCE;
  delete process.env.MUSICMUTE_OWNERSHIP_ROLE;
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    role !== "prepare" ||
    !nonce ||
    !/^[a-f0-9]{64}$/.test(nonce) ||
    argv.length !== 2 ||
    argv[0] !== "--consumer-config" ||
    !argv[1]
  )
    throw new Error("PREPARE_CONTEXT_INVALID");
  const root = win32.resolve(process.cwd()),
    configPath = win32.join(root, "prepare-config.json");
  if (win32.resolve(argv[1]).toLowerCase() !== configPath.toLowerCase())
    throw new Error("PREPARE_CONFIG_INVALID");
  const stat = await lstat(configPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 4096
  )
    throw new Error("PREPARE_CONFIG_INVALID");
  const rawConfiguration: unknown = JSON.parse(
    await readFile(configPath, "utf8"),
  );
  const cloudConfiguration = isCloudMediaOperation(rawConfiguration)
    ? parseCloudMediaChildConfig(rawConfiguration)
    : null;
  const silenceConfiguration = isSilenceOperation(rawConfiguration)
    ? parseSilenceChildConfig(rawConfiguration)
    : null;
  const benchmarkConfiguration = isAdvancedBenchmarkOperation(rawConfiguration)
    ? parseAdvancedBenchmarkConfiguration(rawConfiguration)
    : null;
  const diagnosticConfiguration = isDiagnosticDoctorOperation(rawConfiguration)
    ? parseDiagnosticDoctorConfiguration(rawConfiguration)
    : null;
  const browserCheckConfiguration = isBrowserYoutubeCheckOperation(
    rawConfiguration,
  )
    ? parseBrowserYoutubeCheckConfiguration(rawConfiguration)
    : null;
  const headerConfiguration =
    cloudConfiguration ??
    silenceConfiguration ??
    benchmarkConfiguration ??
    diagnosticConfiguration ??
    browserCheckConfiguration ??
    parsePreparationChildConfig(rawConfiguration);
  const releaseRoot = win32.join(
    root,
    "runtime",
    "releases",
    headerConfiguration.release,
  );
  if (
    win32.resolve(process.execPath).toLowerCase() !==
      win32.join(releaseRoot, "runtime", "node", "node.exe").toLowerCase() ||
    win32.resolve(process.argv[1] ?? "").toLowerCase() !==
      win32.join(releaseRoot, "agent", "prepare.cjs").toLowerCase()
  )
    throw new Error("PREPARE_CONTEXT_INVALID");
  const manifest = await verifyWindowsRelease(releaseRoot, "windows-user");
  const manifestDigest = createHash("sha256")
    .update(await readFile(win32.join(releaseRoot, "release-manifest.json")))
    .digest("hex");
  const helper = manifest.entries.find(
    (entry) =>
      entry.kind === "file" &&
      entry.path === "runtime/native/musicmute-native.exe",
  );
  if (
    manifestDigest !== headerConfiguration.manifestSha256 ||
    helper?.kind !== "file" ||
    helper.sha256 !== headerConfiguration.helperSha256
  )
    throw new Error("PREPARE_INTEGRITY_INVALID");
  const native = new WindowsConsumerNative(
    await createConsumerNativeTransport(
      win32.join(releaseRoot, "runtime", "native", "musicmute-native.exe"),
      headerConfiguration.helperSha256,
    ),
  );
  try {
    const host = await HostContext.initialize(native, "0.1.0", 1);
    if (
      host.identity.sid !== headerConfiguration.sid ||
      win32.normalize(host.personalRoot).toLowerCase() !== root.toLowerCase()
    )
      throw new Error("PREPARE_CONTEXT_INVALID");
    await native.validatePath("personal", "prepare-config.json", "file");
    if (browserCheckConfiguration) {
      await runBrowserYoutubeCheckChild(
        host,
        browserCheckConfiguration,
        releaseRoot,
      );
      return;
    }
    if (diagnosticConfiguration) {
      await runDiagnosticDoctorChild(
        host,
        diagnosticConfiguration,
        releaseRoot,
      );
      return;
    }
    if (benchmarkConfiguration) {
      await runAdvancedBenchmarkChild(
        host,
        benchmarkConfiguration,
        releaseRoot,
      );
      return;
    }
    if (silenceConfiguration) {
      await runSilenceChild(host, silenceConfiguration, releaseRoot);
      return;
    }
    if (cloudConfiguration) {
      await runCloudMediaChild(host, cloudConfiguration, releaseRoot);
      return;
    }
    const configuration = parsePreparationChildConfig(rawConfiguration);
    resolveQualifiedGpuIdentity(
      configuration.gpu,
      await native.enumerateGpus(),
    );
    const signal = AbortSignal.timeout(14 * 60_000);
    const fixtureRelative =
        configuration.approvedFixture?.relativePath ??
        `fixtures\\${PREPARATION_FIXTURE.filename}`,
      fixtureBytes =
        configuration.approvedFixture?.bytes ?? PREPARATION_FIXTURE.bytes,
      fixtureSha256 =
        configuration.approvedFixture?.sha256 ?? PREPARATION_FIXTURE.sha256;
    if (
      (await hashPrivateFile(
        host,
        `models\\${MODEL.filename}`,
        MODEL.bytes,
        signal,
      )) !== MODEL.sha256 ||
      (await hashPrivateFile(host, fixtureRelative, fixtureBytes, signal)) !==
        fixtureSha256
    )
      throw new Error("PREPARE_INTEGRITY_INVALID");
    const workRoot = await host.directory(
      `prepare\\work\\${configuration.requestId}`,
    );
    await host.directory("prepare\\results");
    const output = `prepare\\results\\${configuration.requestId}.json`;
    if (configuration.operation === "inspect") {
      const result = await execute(
        win32.join(releaseRoot, "runtime", "python", "python.exe"),
        [
          "-I",
          "-c",
          "import json,sys;sys.path.insert(0,sys.argv[1]);from musicmute_engine.windows_gpu import enumerate_adapters;from musicmute_engine.qualification import service_identity;print(json.dumps({'version':1,'sid':service_identity(),'gpus':enumerate_adapters()}))",
          win32.join(releaseRoot, "app", "engine"),
        ],
        {
          windowsHide: true,
          cwd: workRoot,
          maxBuffer: 65536,
          timeout: 60000,
          signal,
        },
      );
      await writePrivateAtomic(host, output, Buffer.from(result.stdout));
      return;
    }
    const raw = `prepare\\results\\${configuration.requestId}.raw.json`;
    await native.validatePath("personal", raw, "absent");
    await execute(
      win32.join(releaseRoot, "runtime", "python", "python.exe"),
      [
        "-I",
        "-c",
        "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('musicmute_engine.qualification',run_name='__main__')",
        win32.join(releaseRoot, "app", "engine"),
        "--provider",
        "directml",
        "--fixture",
        win32.join(host.personalRoot, fixtureRelative),
        "--fixture-sha256",
        fixtureSha256,
        "--work-root",
        workRoot,
        "--release-root",
        releaseRoot,
        "--model-cache",
        win32.join(host.personalRoot, "models"),
        "--ffmpeg",
        win32.join(releaseRoot, "runtime", "bin", "ffmpeg.exe"),
        "--ffprobe",
        win32.join(releaseRoot, "runtime", "bin", "ffprobe.exe"),
        "--runtime-profile",
        "windows-user",
        "--expected-user-sid",
        host.identity.sid,
        "--directml-device-id",
        String(configuration.gpu.deviceIndex),
        "--report",
        win32.join(host.personalRoot, raw),
      ],
      {
        windowsHide: true,
        cwd: workRoot,
        timeout: 14 * 60_000,
        maxBuffer: 256 * 1024,
        signal,
      },
    );
    const bytes = await readPrivateBytes(host, raw, 16384),
      report: unknown = JSON.parse(bytes.toString("utf8"));
    const evidence = parseQualificationEvidence(report, {
      runtimeProfile: "windows-user",
      expectedUserSid: host.identity.sid,
      expectedFixtureDigest: fixtureSha256,
    });
    if (
      evidence.modelDigest !== MODEL.sha256 ||
      evidence.releaseManifestDigest !== configuration.manifestSha256 ||
      evidence.runtimeDiagnostics?.onnxRuntime !== "1.24.4"
    )
      throw new Error("PREPARE_INTEGRITY_INVALID");
    await native.validatePath("personal", output, "absent");
    await writePrivateAtomic(host, output, bytes);
  } finally {
    await native.close();
  }
}
if (typeof require !== "undefined" && require.main === module) {
  runPreparationChild().catch(() => {
    process.exitCode = 1;
  });
}
