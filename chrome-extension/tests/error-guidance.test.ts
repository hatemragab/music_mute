import { describe, expect, it, vi } from "vitest";
import { cloudHandoffUrl } from "../src/shared/app-handoff";
import {
  isErrorContext,
  projectErrorContext,
} from "../src/shared/error-context";
import { failureGuidance } from "../src/extension/error-guidance";
import {
  safeLocalErrors,
  localErrorReport,
} from "../src/extension/local-error-report";
import {
  isExtensionMessage,
  type ExtensionStatus,
} from "../src/extension/messages";

describe("safe user guidance and local reports", () => {
  it.each([
    ["WORKER_UPDATE_REQUIRED", "update or move"],
    ["WORKER_MAINTENANCE_BUSY", "Wait for that operation"],
    ["WORKER_PERSONAL_BUSY", "Another local preparation"],
    ["WORKER_WAIT_TIMEOUT", "accepted background job"],
    ["WORKER_COORDINATION_UNSAFE", "Worker diagnostics"],
    ["WORKER_COORDINATION_UNAVAILABLE", "Worker diagnostics"],
    ["ENGINE_EXIT_UNCONFIRMED", "Worker diagnostics"],
  ])(
    "explains %s as local GPU coordination rather than internet or account failure",
    (code, fragment) => {
      const guidance = failureGuidance(code);
      expect(guidance.message).toContain(fragment);
      expect(guidance.message).not.toMatch(/internet|sign in|Prepare my Mac/i);
      expect(guidance.openApp).toBe(true);
      expect(guidance.cloud).toBe(false);
      expect(guidance.cloudPrimary).toBe(false);
    },
  );
  it.each([
    ["ACCOUNT_REQUIRED", "sign in to the account"],
    ["ACCOUNT_SESSION_UNAVAILABLE", "sign in again"],
    ["PROCESSING_SELECTION_CHANGED", "saved processing choice changed"],
    ["PROCESSING_BRIDGE_UNAVAILABLE", "check for an app update"],
  ])("gives an actionable app repair for %s", (code, action) => {
    const guidance = failureGuidance(code);
    expect(guidance.message).toContain(action);
    expect(guidance.openApp).toBe(true);
    expect(guidance.cloud).toBe(false);
  });
  it("distinguishes an interrupted hold, bot refusal and request limit with a local countdown", () => {
    for (const [reason, fragment] of [
      ["ACQUISITION_INTERRUPTED", "interrupted"],
      ["SOURCE_BOT_CHALLENGE", "bot check"],
      ["ACQUISITION_RATE_LIMITED", "request limit"],
    ] as const) {
      const context = {
        retry_at: 1_060_000,
        block_reason: reason,
        stage: "metadata",
      } as const;
      const guidance = failureGuidance(
        "ACQUISITION_COOLDOWN",
        context,
        1_000_000,
      );
      expect(guidance.message).toContain(fragment);
      expect(guidance.message).toContain("1:00");
      expect(guidance.message).toContain("local files remain usable");
      expect(
        failureGuidance("ACQUISITION_COOLDOWN", context, 1_060_000).message,
      ).toContain("YouTube can still refuse");
      expect(guidance.cloud).toBe(true);
      expect(guidance.cloudPrimary).toBe(true);
      expect(guidance.message.startsWith("Use MusicMute cloud")).toBe(true);
      expect(
        failureGuidance("ACQUISITION_COOLDOWN", context, 1_060_000)
          .cloudPrimary,
      ).toBe(false);
    }
  });
  it.each([
    "DENO_MISSING",
    "DENO_VERSION_INVALID",
    "PO_TOKEN_PROVIDER_MISSING",
    "PO_TOKEN_PROVIDER_INVALID",
    "PO_TOKEN_PROVIDER_UNAVAILABLE",
    "YT_DLP_VERSION_UNSUPPORTED",
  ])("offers a setup repair for %s", (code) => {
    const guidance = failureGuidance(code);
    expect(guidance.openApp).toBe(true);
    expect(guidance.message).toContain("Prepare my Mac");
  });
  it("offers connection guidance for token generation without prescribing reinstallation", () => {
    const guidance = failureGuidance("SOURCE_TOKEN_REQUIRED");
    expect(guidance.message).toContain("Check your internet connection");
    expect(guidance.message).not.toMatch(/Repair|Prepare my Mac/);
    expect(guidance.cloud).toBe(true);
    expect(guidance.cloudPrimary).toBe(false);
    expect(failureGuidance("SETUP_REQUIRED").cloud).toBe(true);
  });
  it("keeps runtime challenges, playback tokens and bot acceptance separate", () => {
    expect(failureGuidance("SOURCE_CHALLENGE_FAILED").message).toContain(
      "Deno runtime, EJS",
    );
    expect(failureGuidance("SOURCE_TOKEN_REQUIRED").message).toContain(
      "PO-token provider",
    );
    expect(failureGuidance("SOURCE_TOKEN_REQUIRED").message).toContain(
      "cannot guarantee",
    );
    expect(failureGuidance("SOURCE_BOT_CHALLENGE").message).not.toContain(
      "sign into Chrome",
    );
  });
  it("explains audio format failures without treating MusicMute sign-in or cloud as a repair", () => {
    const guidance = failureGuidance("SOURCE_AUDIO_FORMAT_UNAVAILABLE");
    expect(guidance.title).toBe("YouTube audio unavailable");
    expect(guidance.message).toContain(
      "Signing in to MusicMute does not change YouTube download access",
    );
    expect(guidance.message).toContain("check or repair the YouTube tools");
    expect(guidance.message).toContain("check for an app update");
    expect(guidance.openApp).toBe(true);
    expect(guidance.cloud).toBe(false);
  });
  it("drops private and malformed error evidence rather than reflecting it", () => {
    const privateInput = {
      stage: "https://private.invalid?token=secret",
      http_status: 403,
      retry_at: "tomorrow",
      stderr: "private audio",
      cookie: "secret",
    };
    expect(isErrorContext(privateInput)).toBe(false);
    expect(projectErrorContext(privateInput)).toEqual({ http_status: 403 });
    expect(
      isExtensionMessage({
        type: "MM_ERROR",
        code: "SOURCE_HTTP_FORBIDDEN",
        generation: 1,
        error_context: privateInput,
      }),
    ).toBe(false);
    for (const value of [
      null,
      [],
      { http_status: "403" },
      { stage: "arbitrary" },
      { retry_at: Infinity },
      { retry_at: -1 },
    ])
      expect(isErrorContext(value)).toBe(false);
  });
  it("projects unknown uppercase/current/history codes to the shared fixed code without invoking hostile fields", () => {
    const secret = "BEARER_SUPER_SECRET_TOKEN_123456";
    // Wire compatibility remains separate from safe exported diagnostics.
    expect(
      isExtensionMessage({ type: "MM_ERROR", code: secret, generation: 1 }),
    ).toBe(true);
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    const stringify = vi.fn(() => {
      throw new Error(secret);
    });
    const row = {
      component: "extension",
      severity: "error",
      event: "job_failed",
      code: secret,
    };
    const accessorCode = { ...row };
    Object.defineProperty(accessorCode, "code", {
      get: getter,
      enumerable: true,
    });
    const accessorStage = {
      ...row,
      code: "DENO_MISSING",
      metrics: Object.defineProperty({}, "stage", { get: getter }),
    };
    const accessorEvent = { ...row };
    Object.defineProperty(accessorEvent, "event", { get: getter });
    const throwingProxy = new Proxy(row, {
      getOwnPropertyDescriptor: () => {
        throw new Error(secret);
      },
    });
    const history = [
      row,
      accessorCode,
      accessorStage,
      accessorEvent,
      throwingProxy,
      { ...row, code: { toString: stringify } },
    ];
    expect(safeLocalErrors(history)).toEqual([
      {
        component: "extension",
        severity: "error",
        event: "job_failed",
        code: "UNKNOWN_ERROR",
      },
      {
        component: "extension",
        severity: "error",
        event: "job_failed",
        code: "UNKNOWN_ERROR",
      },
      {
        component: "extension",
        severity: "error",
        event: "job_failed",
        code: "DENO_MISSING",
      },
      {
        component: "extension",
        severity: "error",
        event: "job_failed",
        code: "UNKNOWN_ERROR",
      },
    ]);
    const array = [row];
    Object.defineProperty(array, "0", { get: getter });
    expect(safeLocalErrors(array)).toEqual([]);
    const report = localErrorReport({
      hello: null,
      job: null,
      error: secret,
      diagnostics: history as unknown as ExtensionStatus["diagnostics"],
    });
    expect(report).toContain("Last error: UNKNOWN_ERROR");
    expect(report).not.toContain(secret);
    expect(report).toContain("Setup to repair the tools");
    expect(getter).not.toHaveBeenCalled();
    expect(stringify).not.toHaveBeenCalled();
  });
  it("bounds exports and projects historical storage again on read", () => {
    const rows = Array.from({ length: 80 }, () => ({
      component: "extension",
      severity: "error",
      event: "job_failed",
      code: "SOURCE_TOKEN_REQUIRED",
      metrics: {
        stage: "metadata",
        token: "secret",
        url: "https://private.invalid",
      },
      recorded_at: "2026-10-04T12:00:00.000Z",
      credentials: "secret",
      source: "private",
    }));
    const safe = safeLocalErrors(rows);
    expect(safe).toHaveLength(50);
    expect(safe[0]).toEqual({
      component: "extension",
      severity: "error",
      event: "job_failed",
      code: "SOURCE_TOKEN_REQUIRED",
      metrics: { stage: "metadata" },
      recorded_at: "2026-10-04T12:00:00.000Z",
    });
    const report = localErrorReport({
      hello: null,
      job: null,
      diagnostics: safe,
    });
    expect(report).toContain("PO-token provider");
    expect(report).not.toMatch(/https:|secret|credentials:|source:/);
    expect(
      safeLocalErrors([
        {
          component: "extension",
          severity: "error",
          event: "https://private.invalid",
          code: "ERROR",
        },
      ]),
    ).toEqual([]);
  });
});

describe("explicit cloud app handoff", () => {
  it("passes only canonical video identity and a bounded advisory duration", () => {
    expect(cloudHandoffUrl("abcdefghijk", 120.01)).toBe(
      "musicmute-local://cloud?video_id=abcdefghijk&duration_seconds=121",
    );
    for (const duration of [NaN, Infinity, -1, 0, 1201])
      expect(cloudHandoffUrl("abcdefghijk", duration)).toBe(
        "musicmute-local://cloud?video_id=abcdefghijk",
      );
    for (const id of [
      "abcdefghijk\n",
      "https://www.youtube.com/watch?v=abcdefghijk",
      "short",
      "abcdefghijk&token=secret",
    ])
      expect(() => cloudHandoffUrl(id)).toThrow("INVALID_VIDEO_ID");
  });
});
