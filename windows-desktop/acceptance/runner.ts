import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseStrictJson } from "../../chrome-extension/src/shared/strict-json.js";
import { createAcceptancePlan, parseAcceptanceEvidence } from "./plan.js";
import {
  nativeAcceptanceSourceDigest,
  runNativeAcceptance,
} from "./native-run.js";
export type AcceptanceInvocation =
  | { mode: "plan"; target: string; output: string; prior: string | null }
  | {
      mode: "run-native";
      target: string;
      tools: string;
      output: string;
      cases: string[];
      acknowledgeWindowsPhase: true;
    }
  | { mode: "source-digest" };
function path(value: string | undefined): string {
  if (
    !value ||
    value.length > 4096 ||
    !isAbsolute(value) ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new Error("ACCEPTANCE_ARGUMENT_INVALID");
  return value;
}
export function parseAcceptanceInvocation(
  argv: readonly string[],
): AcceptanceInvocation {
  if (argv.length === 1 && argv[0] === "source-digest")
    return { mode: "source-digest" };
  if (argv[0] === "plan" && (argv.length === 3 || argv.length === 4))
    return {
      mode: "plan",
      target: path(argv[1]),
      output: path(argv[2]),
      prior: argv[3] ? path(argv[3]) : null,
    };
  if (
    argv[0] === "run-native" &&
    argv.length === 6 &&
    argv[5] === "--acknowledge-windows-phase"
  ) {
    const cases = (argv[4] ?? "").split(",");
    if (
      cases.length < 1 ||
      cases.length > 2 ||
      new Set(cases).size !== cases.length ||
      cases.some(
        (id) => id !== "native-build" && id !== "native-security-fixtures",
      )
    )
      throw new Error("ACCEPTANCE_ACTION_DENIED");
    return {
      mode: "run-native",
      target: path(argv[1]),
      tools: path(argv[2]),
      output: path(argv[3]),
      cases,
      acknowledgeWindowsPhase: true,
    };
  }
  throw new Error("ACCEPTANCE_ARGUMENT_INVALID");
}
async function json(path: string, maximum = 65536): Promise<unknown> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > maximum
  )
    throw new Error("ACCEPTANCE_FILE_INVALID");
  return parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)),
    maximum,
  );
}
export async function acceptanceMain(
  argv: readonly string[],
  componentRoot: string,
): Promise<void> {
  const invocation = parseAcceptanceInvocation(argv),
    repository = resolve(componentRoot, "..");
  if (invocation.mode === "source-digest") {
    process.stdout.write(`${await nativeAcceptanceSourceDigest(repository)}\n`);
    return;
  }
  const parent = await lstat(invocation.output);
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error("ACCEPTANCE_FILE_INVALID");
  const target = await json(invocation.target);
  if (invocation.mode === "run-native") {
    const result = await runNativeAcceptance({
      repository,
      outputRoot: invocation.output,
      target,
      tools: await json(invocation.tools),
      cases: invocation.cases,
      acknowledgeWindowsPhase: true,
    });
    process.stdout.write(
      JSON.stringify({
        version: 1,
        result,
        boundary:
          "Actual isolated Windows build/CTest only; app/install/GPU/live/publication acceptance remains separate.",
      }) + "\n",
    );
    if (result.some((row) => row.state !== "passed")) process.exitCode = 2;
    return;
  }
  const prior = invocation.prior
    ? await json(invocation.prior, 4 * 1024 ** 2)
    : [];
  if (!Array.isArray(prior)) throw new Error("ACCEPTANCE_INVALID");
  const plan = createAcceptancePlan(target, undefined, [], prior);
  for (const value of prior) {
    const row = parseAcceptanceEvidence(value);
    if (row.state !== "passed" || !row.artifact) continue;
    const file = join(dirname(invocation.prior!), row.artifact),
      stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > 16 * 1024 ** 2 ||
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex") !== row.artifactSha256
    )
      throw new Error("ACCEPTANCE_ARTIFACT_MISMATCH");
  }
  const folder = join(
    invocation.output,
    `MusicMuteAcceptancePlan-${randomUUID()}`,
  );
  await mkdir(folder);
  await writeFile(
    join(folder, "acceptance-plan.json"),
    JSON.stringify(plan, null, 2) + "\n",
    { flag: "wx" },
  );
  process.stdout.write(
    JSON.stringify({
      version: 1,
      mode: "plan",
      caseCount: plan.cases.length,
      windowsExecuted: false,
      output: folder,
    }) + "\n",
  );
}
if (typeof require === "function" && require.main === module)
  void acceptanceMain(process.argv.slice(2), resolve(__dirname, "../..")).catch(
    (error) => {
      process.stderr.write(
        `${error instanceof Error && /^ACCEPTANCE_[A-Z_]+$/u.test(error.message) ? error.message : "ACCEPTANCE_FAILED"}\n`,
      );
      process.exitCode = 2;
    },
  );
