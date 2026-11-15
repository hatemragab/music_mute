import { describe, expect, it } from "vitest";
import { ChildCommandError as LegacyChildCommandError } from "../src/agent/child-process.js";
import { ChildCommandError } from "../src/agent/ipc/child-command-error.js";

describe("shared real child command error", () => {
  it("preserves the existing class identity used by runtime error routing", () => {
    expect(LegacyChildCommandError).toBe(ChildCommandError);
    const error = new ChildCommandError("GPU_OOM", "bounded engine summary");
    expect(error).toBeInstanceOf(LegacyChildCommandError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("GPU_OOM");
    expect(error.summary).toBe("bounded engine summary");
    expect(error.name).toBe("ChildCommandError");
    expect(error.message).toBe(
      "Worker child command failed: GPU_OOM (bounded engine summary)",
    );
    expect(new LegacyChildCommandError("CHILD_ERROR").message).toBe(
      "Worker child command failed: CHILD_ERROR",
    );
  });
});
