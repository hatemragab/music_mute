import { expect, it } from "vitest";
import { pnpmInvocation } from "../src/platform/production-dependencies.js";

it("runs Windows pnpm through Node without a command shell", () => {
  const path = "C:\\Build tools\\node_modules\\pnpm\\bin\\pnpm.cjs";
  const arguments_ = ["exec", "sentry-cli", "path with spaces & symbols"];
  expect(pnpmInvocation(arguments_, "win32", path)).toEqual({
    command: process.execPath,
    arguments: [path, ...arguments_],
  });
  expect(() => pnpmInvocation([], "win32", "C:\\tools\\pnpm.cmd")).toThrow(
    "pnpm run",
  );
  expect(() => pnpmInvocation([], "win32", "pnpm.cjs")).toThrow("pnpm run");
  expect(pnpmInvocation(["install"], "darwin", undefined)).toEqual({
    command: "pnpm",
    arguments: ["install"],
  });
});
