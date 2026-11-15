import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const execute = promisify(execFile);
test(
  "consumer helper portable C++ parser rejects malformed frames",
  { skip: process.platform === "win32" },
  async () => {
    const temporary = await mkdtemp(
      join(tmpdir(), "musicmute-consumer-parser-"),
    );
    try {
      const executable = join(temporary, "json-test");
      await execute(
        "clang++",
        [
          "-std=c++20",
          "-Wall",
          "-Wextra",
          "-Werror",
          fileURLToPath(
            new URL(
              "../native/windows-consumer/json.test.cpp",
              import.meta.url,
            ),
          ),
          "-o",
          executable,
        ],
        { timeout: 30_000, maxBuffer: 16_384 },
      );
      const result = await execute(executable, [], {
        timeout: 5_000,
        maxBuffer: 4096,
      });
      assert.match(result.stdout, /Consumer JSON parser policy passed/u);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
