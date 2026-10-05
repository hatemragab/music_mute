import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface FailureContext {
  phase: string;
  release: boolean;
  build_id?: string;
  bundle_path?: string;
  timeout_ms?: number;
  tool_failure?: unknown;
}
interface FailureReport {
  schema_version: number;
  build_id: string | null;
  release_mode: boolean;
  phase: string;
  bundle_path: string | null;
  failure_kind: string;
  error_code: string;
  exit_code: number | null;
  signal: string | null;
  timeout_ms: number | null;
  public_ready: boolean;
  notarized: boolean;
}
interface FailureModule {
  packageFailureReport(error: unknown, context: FailureContext): FailureReport;
  writePackageFailure(buildRoot: string, report: FailureReport): Promise<void>;
}
const failureUrl = new URL(
  "../scripts/macos-package-failure.mjs",
  import.meta.url,
).href;
const { packageFailureReport, writePackageFailure } = (await import(
  failureUrl
)) as FailureModule;
const buildId = "f9ca928f-087f-4147-973d-749a300a4c21";
const context: FailureContext = {
  phase: "SIGN_NATIVE",
  release: true,
  build_id: buildId,
  bundle_path:
    "Contents/Resources/runtime/runtime/python/lib/python3.13/site-packages/fixture/native.so",
  timeout_ms: 60_000,
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("safe macOS package failure evidence", () => {
  it.each([
    "DESKTOP_PUBLIC_CONFIG_MISSING",
    "DESKTOP_PUBLIC_CONFIG_UNREADABLE",
  ])(
    "identifies public configuration staging without exposing its path: %s",
    (code) => {
      const report = packageFailureReport(new Error(code), {
        phase: "PUBLIC_CONFIG",
        release: context.release,
      });
      expect(report).toMatchObject({
        phase: "PUBLIC_CONFIG",
        error_code: code,
        failure_kind: "VALIDATION",
        bundle_path: null,
        public_ready: false,
      });
    },
  );
  it("retains failed build identity and distinguishes controlled tool timeout without copying raw output", () => {
    const report = packageFailureReport(
      Object.assign(
        new Error(
          "codesign failed Developer ID Application: PRIVATE (/Users/private)",
        ),
        {
          killed: true,
          code: null,
          signal: "SIGTERM",
          cmd: "codesign --sign PRIVATE",
          stderr: "PRIVATE /Users/private secret@example.test",
          stdout: "TOKEN",
        },
      ),
      context,
    );
    expect(report).toMatchObject({
      build_id: buildId,
      phase: "SIGN_NATIVE",
      bundle_path: context.bundle_path,
      failure_kind: "TIMEOUT",
      error_code: "MACOS_RELEASE_SIGN_NATIVE_TIMEOUT",
      timeout_ms: 60_000,
      public_ready: false,
      notarized: false,
    });
    expect(JSON.stringify(report)).not.toMatch(
      /PRIVATE|TOKEN|\/Users\/|@example/,
    );
  });
  it("distinguishes numeric tool exit from a timeout", () => {
    expect(
      packageFailureReport(
        { killed: false, code: 1, signal: null, stderr: "PRIVATE" },
        context,
      ),
    ).toMatchObject({
      failure_kind: "EXIT",
      exit_code: 1,
      timeout_ms: null,
      error_code: "MACOS_RELEASE_SIGN_NATIVE_EXIT",
    });
  });
  it("does not label an unrelated signal or unbounded kill as timeout", () => {
    expect(
      packageFailureReport(
        { killed: true, code: null, signal: "SIGKILL" },
        context,
      ).failure_kind,
    ).toBe("SIGNAL");
    expect(
      packageFailureReport(
        { killed: true, code: null, signal: "SIGTERM" },
        { phase: "SIGN_NATIVE", release: true },
      ).failure_kind,
    ).toBe("SIGNAL");
  });
  it("recognizes output limit independently of the child being killed", () => {
    expect(
      packageFailureReport(
        {
          killed: true,
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          signal: "SIGTERM",
        },
        context,
      ).failure_kind,
    ).toBe("OUTPUT_LIMIT");
  });
  it("retains safe timeout metadata when a signing helper suppresses raw tool errors", () => {
    const report = packageFailureReport(
      new Error("RELEASE_SIGNATURE_VERIFICATION_FAILED"),
      {
        ...context,
        phase: "VERIFY_NATIVE",
        timeout_ms: 30_000,
        tool_failure: { killed: true, code: null, signal: "SIGTERM" },
      },
    );
    expect(report).toMatchObject({
      phase: "VERIFY_NATIVE",
      error_code: "RELEASE_SIGNATURE_VERIFICATION_FAILED",
      failure_kind: "TIMEOUT",
      timeout_ms: 30_000,
    });
  });
  it("keeps only explicitly known validation codes", () => {
    expect(
      packageFailureReport(
        new Error("RELEASE_SIGNATURE_VERIFICATION_FAILED"),
        context,
      ),
    ).toMatchObject({
      error_code: "RELEASE_SIGNATURE_VERIFICATION_FAILED",
      failure_kind: "VALIDATION",
    });
    expect(
      JSON.stringify(
        packageFailureReport(new Error("SECRET_ACCESS_TOKEN"), context),
      ),
    ).not.toContain("SECRET_ACCESS_TOKEN");
  });
  it.each([
    "/Users/private/native.so",
    "Contents/../private",
    "Contents/a/../../private",
    "Contents/a\nPRIVATE",
    "Contents/a//b",
    "Contents/a?TOKEN",
  ])("refuses an unsafe path instead of serializing it: %s", (path) => {
    expect(
      packageFailureReport(new Error("PRIVATE"), {
        ...context,
        bundle_path: path,
      }).bundle_path,
    ).toBeNull();
  });
  it("bounds and validates metadata and never retains arbitrary phase/build/signal values", () => {
    const report = packageFailureReport(
      { signal: "PRIVATE_SIGNAL" },
      {
        phase: "PRIVATE_PHASE",
        release: true,
        build_id: "/Users/private",
        timeout_ms: 900_001,
      },
    );
    expect(report).toMatchObject({
      phase: "UNKNOWN",
      build_id: null,
      signal: null,
      timeout_ms: null,
    });
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
  });
  it("keeps the development packaging error namespace", () => {
    expect(
      packageFailureReport({}, { ...context, release: false }).error_code,
    ).toBe("MACOS_PACKAGE_SIGN_NATIVE_UNKNOWN");
  });
  it("writes a private durable report while preserving incomplete bundle artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-package-failure-"));
    roots.push(root);
    const build = join(root, `build-${buildId}.noindex`);
    await mkdir(build, { mode: 0o700 });
    const retained = join(build, "incomplete-native");
    await writeFile(retained, "preserved");
    const report = packageFailureReport(
      { killed: true, code: null, signal: "SIGTERM" },
      context,
    );
    await writePackageFailure(build, report);
    const record = join(build, "package-failure.json");
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual(report);
    expect((await lstat(record)).mode & 0o777).toBe(0o600);
    expect(await readFile(retained, "utf8")).toBe("preserved");
    await expect(writePackageFailure(build, report)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual(report);
  });
  it("refuses mismatched build identity, linked/writable roots and preserves unrelated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-package-failure-"));
    roots.push(root);
    const build = join(root, `build-${buildId}.noindex`);
    await mkdir(build, { mode: 0o700 });
    const report = packageFailureReport({}, context);
    await expect(
      writePackageFailure(build, { ...report, build_id: randomUUID() }),
    ).rejects.toThrow("INVALID_PACKAGE_FAILURE_ROOT");
    await chmod(build, 0o777);
    await expect(writePackageFailure(build, report)).rejects.toThrow(
      "UNSAFE_PACKAGE_FAILURE_ROOT",
    );
    await chmod(build, 0o700);
    const linkRoot = join(root, "linked");
    await mkdir(linkRoot);
    const link = join(linkRoot, `build-${buildId}.noindex`);
    await symlink(build, link);
    await expect(writePackageFailure(link, report)).rejects.toThrow(
      "UNSAFE_PACKAGE_FAILURE_ROOT",
    );
  });
});
