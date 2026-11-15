import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { nativeCheckArguments } from "./native-check.mjs";

const target = resolve("fixture-target.json"),
  tools = resolve("fixture-tools.json"),
  output = resolve("fixture-output");

test("build/test component commands select only the guarded native runner cases", () => {
  for (const [mode, cases] of [
    ["build", "native-build"],
    ["test", "native-build,native-security-fixtures"],
  ])
    assert.deepEqual(
      nativeCheckArguments([
        mode,
        target,
        tools,
        output,
        "--acknowledge-windows-phase",
      ]),
      [
        "run-native",
        target,
        tools,
        output,
        cases,
        "--acknowledge-windows-phase",
      ],
    );
});

test("missing acknowledgement, relative paths, extra commands and tool flags are denied", () => {
  for (const argv of [
    ["build"],
    ["test", target, tools, output],
    ["build", target, tools, output, "--allow"],
    ["build", "relative.json", tools, output, "--acknowledge-windows-phase"],
    [
      "test",
      target,
      tools,
      `${output}\nprivate`,
      "--acknowledge-windows-phase",
    ],
    ["configure", target, tools, output, "--acknowledge-windows-phase"],
    [
      "test",
      target,
      tools,
      output,
      "--acknowledge-windows-phase",
      "-DCMAKE_TOOLCHAIN_FILE=bad",
    ],
  ])
    assert.throws(
      () => nativeCheckArguments(argv),
      /ACCEPTANCE_ARGUMENT_INVALID/u,
    );
});

test(
  "actual non-Windows CLI refuses before loading any runner, target or external tool",
  {
    skip: process.platform === "win32",
  },
  () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "native-check.mjs"),
        "test",
        target,
        tools,
        output,
        "--acknowledge-windows-phase",
      ],
      { encoding: "utf8", timeout: 5000, env: { PATH: "" } },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^ACCEPTANCE_WINDOWS_PHASE_REQUIRED\n/u);
    assert.doesNotMatch(result.stderr, /ENOENT|cmake:|ctest:|fixture-target/u);
  },
);
