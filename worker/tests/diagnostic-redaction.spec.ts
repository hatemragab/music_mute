import { describe, expect, it } from "vitest";
import { sanitizeDiagnostic } from "../src/agent/diagnostic-redaction.js";
import { windowsGuardianArguments } from "../src/agent/child-process.js";
describe("pure diagnostic and Windows engine import boundaries", () => {
  it("preserves safe codes while removing secrets and personal roots", () => {
    expect(
      sanitizeDiagnostic(
        "GPU_OOM https://example.test/private Bearer abc token=xyz /Users/name/a C:\\Users\\Name\\input.wav",
      ),
    ).toBe(
      "GPU_OOM [REDACTED_URL] Bearer [REDACTED] token=[REDACTED] /Users/[REDACTED]/a C:\\Users\\[REDACTED]\\input.wav",
    );
  });
  it("loads the guardian from the explicitly verified engine root under isolated Python", () => {
    const args = windowsGuardianArguments(
      "C:\\private runtime\\app\\engine",
      321,
      [
        "-I",
        "-c",
        "fixed-entry",
        "--consumer-config",
        "C:\\private\\config.json",
      ],
    );
    expect(args.slice(0, 3)).toEqual(["-I", "-B", "-c"]);
    expect(args[4]).toBe("C:\\private runtime\\app\\engine");
    expect(args.slice(5, 8)).toEqual(["--parent-pid", "321", "--"]);
    expect(args.slice(8)).toEqual([
      "-I",
      "-c",
      "fixed-entry",
      "--consumer-config",
      "C:\\private\\config.json",
    ]);
    expect(() => windowsGuardianArguments("relative", 321, [])).toThrow();
  });
});
