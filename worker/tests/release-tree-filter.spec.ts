import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shouldCopyReleaseTreeEntry } from "../src/platform/release-tree-filter.js";

describe("release tree filtering", () => {
  it("keeps runtime packages named testing while excluding project test trees", () => {
    const root = join("/tmp", "python-runtime");

    expect(
      shouldCopyReleaseTreeEntry(
        root,
        join(root, "lib", "python3.13", "site-packages", "torch", "testing"),
      ),
    ).toBe(true);
    expect(shouldCopyReleaseTreeEntry(root, join(root, "tests"))).toBe(false);
    expect(shouldCopyReleaseTreeEntry(root, join(root, ".pytest_cache"))).toBe(
      false,
    );
  });
});
