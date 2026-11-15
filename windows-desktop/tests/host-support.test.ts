import { describe, expect, it } from "vitest";
import { checkHostSupport } from "../src/shared/host-support.js";
const host = {
  platform: "win32",
  processArchitecture: "x64",
  nativeArchitecture: "x64",
  osBuild: 19045,
};
describe("native Windows support", () => {
  it.each([19045, 22000, 22621, 26100])(
    "accepts supported x64 build %i",
    (osBuild) =>
      expect(checkHostSupport({ ...host, osBuild })).toEqual({
        supported: true,
      }),
  );
  it.each([19044, 17763, 0, NaN, 19045.1])(
    "rejects older or malformed build %i",
    (osBuild) =>
      expect(checkHostSupport({ ...host, osBuild }).supported).toBe(false),
  );
  it("rejects ARM emulation even when the process is x64", () =>
    expect(checkHostSupport({ ...host, nativeArchitecture: "arm64" })).toEqual({
      supported: false,
      reason: "X64_REQUIRED",
    }));
  it("rejects x86 and other operating systems", () => {
    expect(
      checkHostSupport({ ...host, processArchitecture: "ia32" }).supported,
    ).toBe(false);
    expect(checkHostSupport({ ...host, platform: "darwin" }).supported).toBe(
      false,
    );
  });
});
