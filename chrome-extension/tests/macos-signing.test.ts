import { describe, expect, it, vi } from "vitest";

interface SigningConfig {
  release: boolean;
  identity: string;
  signing: string;
  authority?: string;
  teamIdentifier?: string;
}
interface ToolResult {
  stdout: string;
  stderr: string;
}
type Executor = (
  executable: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<ToolResult>;
interface SigningTools {
  parsePackageMode(args: string[]): { release: boolean };
  parseDeveloperIdIdentities(
    output: string,
  ): Array<{ identity: string; authority: string; teamIdentifier: string }>;
  resolveSigningConfiguration(options: {
    release: boolean;
    identity?: string;
    exec?: Executor;
  }): Promise<SigningConfig>;
  signingArguments(
    config: SigningConfig,
    target?: { entitlements?: string; kind?: string },
  ): string[];
  assertDeveloperIdDisplay(
    output: string,
    config: SigningConfig,
    target?: { kind?: string },
  ): {
    authority: string;
    team_identifier: string;
    secure_timestamp: boolean;
    hardened_runtime: boolean;
  };
  assertNotarizationLoadCommands(output: string): void;
  assertReleaseEntitlements(output: string): void;
  verifyDeveloperIdSignature(
    path: string,
    config: SigningConfig,
    options?: { exec?: Executor; kind?: string },
  ): Promise<unknown>;
}
const signingUrl = new URL("../scripts/macos-signing.mjs", import.meta.url)
  .href;
const signing = (await import(signingUrl)) as SigningTools;
const identity = "A".repeat(40);
const authority = "Developer ID Application: Fixture Team (ABCDEFGHIJ)";
const config: SigningConfig = {
  release: true,
  identity,
  authority,
  teamIdentifier: "ABCDEFGHIJ",
  signing: "DEVELOPER_ID_DISTRIBUTION",
};
const identityOutput = `  1) ${identity} "${authority}"\n     1 valid identities found\n`;
const display = `Executable=/fixture/MusicMute Local.app
Identifier=com.hatem.musicmute.local
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1500 flags=0x10000(runtime) hashes=50+7 location=embedded
Authority=${authority}
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Oct 3, 2026 at 12:00:00 AM
TeamIdentifier=ABCDEFGHIJ
Runtime Version=26.0.0
`;
const loadCommands = `Load command 0
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 13.0
      sdk 26.0
   ntools 1
Load command 1
      cmd LC_RPATH
  cmdsize 48
     path @loader_path/../lib (offset 12)
`;

describe("explicit macOS distribution signing", () => {
  it("keeps default development packaging and requires a standalone release flag", () => {
    expect(signing.parsePackageMode([])).toEqual({ release: false });
    expect(signing.parsePackageMode(["--release"])).toEqual({ release: true });
  });
  it.each([
    ["--release", "--release"],
    ["--help"],
    ["--release=true"],
    ["extra"],
  ])("fails closed for malformed package options %j", (...args: string[]) => {
    expect(() => signing.parsePackageMode(args)).toThrow(
      "INVALID_PACKAGE_OPTIONS",
    );
  });
  it("does not read the keychain for default ad hoc development packaging", async () => {
    const exec = vi.fn<Executor>();
    expect(
      await signing.resolveSigningConfiguration({ release: false, exec }),
    ).toEqual({
      release: false,
      identity: "-",
      signing: "AD_HOC_LOCAL",
    });
    expect(exec).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    "-",
    "Apple Development: Fixture (ABCDEFGHIJ)",
    "Developer ID Installer: Fixture (ABCDEFGHIJ)",
    "",
    "A".repeat(39),
    `${authority}\n`,
  ])(
    "refuses a release without an explicit application identity %s",
    async (value) => {
      const exec = vi.fn<Executor>();
      await expect(
        signing.resolveSigningConfiguration({
          release: true,
          ...(value === undefined ? {} : { identity: value }),
          exec,
        }),
      ).rejects.toThrow("RELEASE_REQUIRES_DEVELOPER_ID_APPLICATION_IDENTITY");
      expect(exec).not.toHaveBeenCalled();
    },
  );
  it("accepts only valid certificate entries, excluding expired/untrusted annotations", () => {
    expect(
      signing.parseDeveloperIdIdentities(`${identityOutput}
  2) ${"B".repeat(40)} "${authority}" (CSSMERR_TP_CERT_EXPIRED)
  3) ${"C".repeat(40)} "Apple Development: Fixture (ABCDEFGHIJ)"
`),
    ).toEqual([{ identity, authority, teamIdentifier: "ABCDEFGHIJ" }]);
  });
  it.each([authority, identity, identity.toLowerCase()])(
    "resolves an exact application CN or fingerprint %s without private key export",
    async (value) => {
      const exec = vi
        .fn<Executor>()
        .mockResolvedValue({ stdout: identityOutput, stderr: "" });
      expect(
        await signing.resolveSigningConfiguration({
          release: true,
          identity: value,
          exec,
        }),
      ).toEqual(config);
      expect(exec).toHaveBeenCalledExactlyOnceWith(
        "/usr/bin/security",
        ["find-identity", "-v", "-p", "codesigning"],
        { timeout: 30_000, maxBuffer: 256 * 1024 },
      );
    },
  );
  it("refuses ambiguous renewed certificates under the same common name", async () => {
    const exec = vi.fn<Executor>().mockResolvedValue({
      stdout: `${identityOutput}  2) ${"B".repeat(40)} "${authority}"\n`,
      stderr: "",
    });
    await expect(
      signing.resolveSigningConfiguration({
        release: true,
        identity: authority,
        exec,
      }),
    ).rejects.toThrow("RELEASE_SIGNING_IDENTITY_NOT_UNIQUE_OR_UNAVAILABLE");
    expect(
      await signing.resolveSigningConfiguration({
        release: true,
        identity,
        exec,
      }),
    ).toEqual(config);
  });
  it("refuses an identity that is no longer available", async () => {
    const exec = vi
      .fn<Executor>()
      .mockResolvedValue({ stdout: "0 valid identities found", stderr: "" });
    await expect(
      signing.resolveSigningConfiguration({ release: true, identity, exec }),
    ).rejects.toThrow("RELEASE_SIGNING_IDENTITY_NOT_UNIQUE_OR_UNAVAILABLE");
  });
  it("projects a safe error when keychain lookup fails", async () => {
    const exec = vi
      .fn<Executor>()
      .mockRejectedValue(new Error("private tool output"));
    await expect(
      signing.resolveSigningConfiguration({ release: true, identity, exec }),
    ).rejects.toThrow("RELEASE_SIGNING_IDENTITY_LOOKUP_FAILED");
  });
  it("signs code with secure timestamps and runtime, preserving runtime-specific entitlements", () => {
    expect(
      signing.signingArguments(config, {
        entitlements: "/fixture/jit.entitlements",
      }),
    ).toEqual([
      "--force",
      "--sign",
      identity,
      "--timestamp",
      "--options",
      "runtime",
      "--entitlements",
      "/fixture/jit.entitlements",
    ]);
    expect(
      signing.signingArguments({
        release: false,
        identity: "-",
        signing: "AD_HOC_LOCAL",
      }),
    ).toContain("--timestamp=none");
  });
  it("signs DMG data without code-only runtime or entitlements", () => {
    expect(signing.signingArguments(config, { kind: "dmg" })).toEqual([
      "--force",
      "--sign",
      identity,
      "--timestamp",
    ]);
    expect(() =>
      signing.signingArguments(config, {
        kind: "dmg",
        entitlements: "unexpected",
      }),
    ).toThrow("DMG_CANNOT_DECLARE_RUNTIME_ENTITLEMENTS");
  });
  it("does not trust forged release configuration", () => {
    expect(() =>
      signing.signingArguments({ ...config, identity: "-" }),
    ).toThrow("RELEASE_SIGNING_CONFIGURATION_INVALID");
    expect(() =>
      signing.signingArguments({ ...config, teamIdentifier: "OTHERTEAM1" }),
    ).toThrow("RELEASE_SIGNING_CONFIGURATION_INVALID");
    expect(() => signing.signingArguments(config, { kind: "unknown" })).toThrow(
      "INVALID_SIGNING_TARGET_KIND",
    );
  });
  it("attests actual Developer ID chain, team, secure timestamp and runtime", () => {
    expect(signing.assertDeveloperIdDisplay(display, config)).toEqual({
      authority,
      team_identifier: "ABCDEFGHIJ",
      secure_timestamp: true,
      hardened_runtime: true,
    });
  });
  it.each([
    display.replace(authority, "Apple Development: Fixture (ABCDEFGHIJ)"),
    display.replace("Authority=Apple Root CA", "Authority=Untrusted Root"),
    display.replace(
      "Authority=Developer ID Certification Authority",
      "Authority=Other Authority",
    ),
    display.replace("TeamIdentifier=ABCDEFGHIJ", "TeamIdentifier=OTHERTEAM1"),
    `${display}TeamIdentifier=ABCDEFGHIJ\n`,
  ])(
    "rejects authority or team mismatches rather than accepting display text",
    (value) => {
      expect(() => signing.assertDeveloperIdDisplay(value, config)).toThrow(
        "RELEASE_SIGNATURE_DEVELOPER_ID_MISMATCH",
      );
    },
  );
  it.each([
    display.replace(/^Timestamp=.*\n/m, ""),
    display.replace(
      "Timestamp=Oct 3, 2026 at 12:00:00 AM",
      "Signed Time=Oct 3, 2026 at 12:00:00 AM",
    ),
    display.replace("Timestamp=Oct 3, 2026 at 12:00:00 AM", "Timestamp=none"),
    `${display}Timestamp=Oct 3, 2026 at 12:00:00 AM\n`,
  ])("rejects absent, insecure and duplicated timestamp evidence", (value) => {
    expect(() => signing.assertDeveloperIdDisplay(value, config)).toThrow(
      "RELEASE_SIGNATURE_SECURE_TIMESTAMP_MISSING",
    );
  });
  it.each([
    display.replace("flags=0x10000(runtime)", "flags=0x0(none)"),
    display.replace("flags=0x10000(runtime)", "flags=0x0(runtime)"),
    display.replace("flags=0x10000(runtime)", "flags=0x10000(none)"),
  ])("requires the actual hardened-runtime flag for code", (value) => {
    expect(() => signing.assertDeveloperIdDisplay(value, config)).toThrow(
      "RELEASE_SIGNATURE_HARDENED_RUNTIME_MISSING",
    );
    expect(
      signing.assertDeveloperIdDisplay(value, config, { kind: "dmg" })
        .hardened_runtime,
    ).toBe(false);
  });
  it("verifies an Apple-anchored Developer ID Application requirement before inspecting display", async () => {
    const exec = vi
      .fn<Executor>()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: display })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    await signing.verifyDeveloperIdSignature(
      "/fixture/MusicMute Local.app",
      config,
      { exec, kind: "app" },
    );
    expect(exec.mock.calls[0]?.[1]).toEqual([
      "--verify",
      "--strict",
      "--all-architectures",
      "--deep",
      "--test-requirement",
      '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "ABCDEFGHIJ"',
      "/fixture/MusicMute Local.app",
    ]);
    expect(exec.mock.calls[1]?.[1]).toEqual([
      "--display",
      "--verbose=4",
      "/fixture/MusicMute Local.app",
    ]);
    expect(exec.mock.calls[2]?.[1]).toEqual([
      "--display",
      "--entitlements",
      "-",
      "--xml",
      "/fixture/MusicMute Local.app",
    ]);
  });
  it("fails before display when signature/anchor verification fails and suppresses raw stderr", async () => {
    const exec = vi
      .fn<Executor>()
      .mockRejectedValue(new Error("private signature tool output"));
    await expect(
      signing.verifyDeveloperIdSignature("/fixture/app", config, { exec }),
    ).rejects.toThrow("RELEASE_SIGNATURE_VERIFICATION_FAILED");
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe("embedded release entitlements", () => {
  it("accepts empty entitlement data and valid ASCII XML runtime exceptions", () => {
    expect(() => signing.assertReleaseEntitlements("")).not.toThrow();
    expect(() =>
      signing.assertReleaseEntitlements(
        '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>',
      ),
    ).not.toThrow();
  });
  it.each([
    "<true/>",
    "<integer>1</integer>",
    "<string>YES</string>",
    "<false/>",
  ])(
    "refuses any debug-key declaration, including unexpected type %s",
    (value) => {
      expect(() =>
        signing.assertReleaseEntitlements(
          `<plist version="1.0"><dict><key>com.apple.security.get-task-allow</key>${value}</dict></plist>`,
        ),
      ).toThrow("RELEASE_DEBUG_ENTITLEMENT_FORBIDDEN");
    },
  );
  it("does not let numeric XML entities disguise the debug entitlement key", () => {
    expect(() =>
      signing.assertReleaseEntitlements(
        '<plist version="1.0"><dict><key>com.apple.security.get&#45;task&#x2d;allow</key><true/></dict></plist>',
      ),
    ).toThrow("RELEASE_DEBUG_ENTITLEMENT_FORBIDDEN");
  });
  it.each([
    "bplist00",
    "\ufeff<plist><dict/></plist>",
    "[Dict]",
    "<plist><dict/>",
  ])(
    "rejects binary, BOM and non-XML embedded entitlement projections %s",
    (value) => {
      expect(() => signing.assertReleaseEntitlements(value)).toThrow(
        "RELEASE_EMBEDDED_ENTITLEMENTS_INVALID",
      );
    },
  );
});

describe("macOS notarization SDK audit", () => {
  it("accepts current build-version load commands", () => {
    expect(() =>
      signing.assertNotarizationLoadCommands(loadCommands),
    ).not.toThrow();
  });
  it("accepts a macOS 10.9 SDK legacy load command", () => {
    expect(() =>
      signing.assertNotarizationLoadCommands(
        "Load command 0\n cmd LC_VERSION_MIN_MACOSX\n cmdsize 16\n version 10.7\n sdk 10.9\n",
      ),
    ).not.toThrow();
  });
  it.each([
    loadCommands.replace("sdk 26.0", "sdk 10.8"),
    loadCommands.replace("sdk 26.0", "sdk 0.0"),
    loadCommands.replace("platform 1", "platform 2"),
    loadCommands.replace("sdk 26.0", "missing"),
  ])("rejects old, missing or non-macOS SDK evidence", (value) => {
    expect(() => signing.assertNotarizationLoadCommands(value)).toThrow(
      "RELEASE_MACOS_SDK_UNSUPPORTED",
    );
  });
  it("checks each included architecture instead of accepting one modern slice", () => {
    expect(() =>
      signing.assertNotarizationLoadCommands(
        `${loadCommands}\n${loadCommands.replace("sdk 26.0", "sdk 10.8")}`,
      ),
    ).toThrow("RELEASE_MACOS_SDK_UNSUPPORTED");
  });
  it("refuses entirely absent build information", () => {
    expect(() =>
      signing.assertNotarizationLoadCommands("Load command 0\n cmd LC_RPATH\n"),
    ).toThrow("RELEASE_MACOS_SDK_UNVERIFIED");
  });
});
