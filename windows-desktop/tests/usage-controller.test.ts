import { describe, expect, it, vi } from "vitest";
import type { AccountView } from "../src/shared/account-contracts.js";
import {
  parseUsage,
  parseProcessingPolicy,
  parseResetTimestamp,
  policyToWire,
  formatUsage,
  processingAdmissionPreview,
} from "../src/main/usage/presentation.js";
import { queueRank } from "../src/main/usage/queue-rank.js";
import { AccountUsageController } from "../src/main/usage/account-usage.js";
import type { AccountUsageView } from "../src/shared/usage-contracts.js";
import {
  realtimeFixture,
  processingPolicy,
  processingUsage,
} from "./realtime-fixtures.js";

describe("usage/policy presentation and authority", () => {
  it("applies newer app-policy snapshots even with an identical processing revision without extra HTTP reads", async () => {
    const h = realtimeFixture(),
      applyAppPolicy = vi.fn(),
      controller = new AccountUsageController({
        realtime: h.controller,
        applyAppPolicy,
      });
    h.setOwner(h.ownerA);
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1));
    const socket = h.sockets[0]!;
    socket.ready();
    const gate = (revision: number, minimum: number | null) => ({
      revision,
      require_verified_email: false,
      platforms: { windows: { minimum_build: minimum } },
    });
    socket.snapshot("s2", { ...processingPolicy(), app_policy: gate(2, 42) });
    socket.snapshot(
      "s2",
      { ...processingPolicy(), app_policy: gate(3, null) },
      2,
    );
    expect(applyAppPolicy.mock.calls.map(([value]) => value.revision)).toEqual([
      2, 3,
    ]);
    expect(controller.view().policy?.revision).toBe(1);
    expect(
      h.calls.filter((call) => !call.url.endsWith("/realtime-tickets")),
    ).toEqual([]);
    h.setOwner(h.ownerB);
    socket.snapshot(
      "s2",
      { ...processingPolicy(), app_policy: gate(4, 99) },
      3,
    );
    expect(applyAppPolicy).toHaveBeenCalledTimes(2);
    controller.dispose();
    h.controller.dispose();
  });
  it("fences a delayed app-open gate after a newer live app-policy snapshot", async () => {
    const h = realtimeFixture();
    let finish!: (response: Response) => void;
    const original = h.fetcher.getMockImplementation()!;
    h.fetcher.mockImplementation(async (url, init) =>
      url.endsWith("/app-policy")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : original(url, init),
    );
    const applyAppPolicy = vi.fn(),
      controller = new AccountUsageController({
        realtime: h.controller,
        applyAppPolicy,
      });
    h.setOwner(h.ownerA);
    const open = controller.onAppOpen();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1));
    const socket = h.sockets[0]!;
    socket.ready();
    const newer = {
      revision: 9,
      require_verified_email: false,
      platforms: { windows: { minimum_build: 42 } },
    };
    socket.snapshot("s2", { ...processingPolicy(), app_policy: newer });
    finish(
      new Response(
        JSON.stringify({
          ...newer,
          revision: 8,
          platforms: { windows: { minimum_build: null } },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    await open;
    expect(applyAppPolicy).toHaveBeenCalledExactlyOnceWith(newer);
    controller.dispose();
    h.controller.dispose();
  });
  it("does not replace a newer owner socket policy with a delayed app-open checkout", async () => {
    const h = realtimeFixture();
    let finish!: (response: Response) => void;
    const original = h.fetcher.getMockImplementation()!;
    h.fetcher.mockImplementation(async (url, init) =>
      url.includes("/processing-policy")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : original(url, init),
    );
    const appPolicy = vi.fn();
    const controller = new AccountUsageController({
      realtime: h.controller,
      applyAppPolicy: appPolicy,
    });
    h.setOwner(h.ownerA);
    const open = controller.onAppOpen();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1));
    const socket = h.sockets[0]!;
    socket.ready();
    socket.snapshot("s1", processingUsage());
    socket.snapshot("s2", processingPolicy(2));
    finish(
      new Response(JSON.stringify(processingPolicy(1)), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await open;
    expect(controller.view().policy?.revision).toBe(2);
    expect(appPolicy).toHaveBeenCalledWith({
      require_verified_email: false,
      platforms: { windows: { minimum_build: null } },
    });
    controller.dispose();
    h.controller.dispose();
  });
  it("validates quota arithmetic, clamps overrun percentages and handles zero allowance", () => {
    const usage = parseUsage(
      processingUsage(),
      Date.parse("2026-10-09T00:00:00Z"),
    );
    expect(usage.usedPercent).toBe(10);
    expect(usage.remainingSeconds).toBe(880);
    const input = processingUsage();
    input.processing.used_seconds = 1200;
    input.processing.reserved_seconds = 0;
    input.processing.remaining_seconds = 0;
    expect(parseUsage(input).usedPercent).toBe(100);
    input.processing.limit_seconds = 0;
    input.processing.used_seconds = 0;
    expect(parseUsage(input).usedPercent).toBe(0);
    input.processing.used_seconds = 1.5;
    expect(() => parseUsage(input)).toThrow();
    const huge = processingUsage();
    huge.processing.used_seconds = Number.MAX_SAFE_INTEGER;
    huge.processing.reserved_seconds = Number.MAX_SAFE_INTEGER;
    huge.processing.limit_seconds = Number.MAX_SAFE_INTEGER;
    huge.processing.remaining_seconds = 0;
    expect(parseUsage(huge).remainingSeconds).toBe(0);
  });
  it.each([
    "2026-02-30T00:00:00Z",
    "2101-01-01T00:00:00Z",
    "2026-10-09",
    "2026-10-09T24:00:00Z",
    "2026-10-09T00:00:00Z\n",
  ])("rejects invalid reset date %s", (value) => {
    expect(() => parseResetTimestamp(value)).toThrow();
  });
  it("formats English/Arabic duration and reset data without inventing a client reset", () => {
    const input = processingUsage();
    input.processing.used_seconds = 0;
    input.processing.reserved_seconds = 0;
    input.processing.remaining_seconds = input.processing.limit_seconds;
    const usage = parseUsage(input, Date.parse("2026-11-02T00:00:00Z"));
    expect(usage.resetOverdue).toBe(true);
    expect(formatUsage(usage, "en", "UTC").remaining).toContain("min");
    expect(formatUsage(usage, "ar", "Africa/Cairo").remaining).not.toBe(
      formatUsage(usage, "en", "UTC").remaining,
    );
    expect(usage.remainingSeconds).toBe(1000);
  });
  it.each([
    {
      fields: {
        link_import_enabled: false,
        link_import_visible: true,
        link_import_reason: "user_hidden",
      },
      reason: "globally_hidden",
      visible: false,
    },
    {
      fields: {
        link_import_reason: "user_hidden",
        link_import_disabled_countries: ["EG"],
        visitor_country: "EG",
        link_import_visible: false,
      },
      reason: "user_hidden",
      visible: false,
    },
    {
      fields: {
        link_import_disabled_countries: ["EG"],
        visitor_country: "EG",
        link_import_visible: false,
      },
      reason: "country_hidden",
      visible: false,
    },
    {
      fields: {
        link_import_disabled_countries: ["EG"],
        visitor_country: null,
        link_import_visible: false,
      },
      reason: "unknown_country",
      visible: false,
    },
    {
      fields: {
        link_import_disabled_countries: ["EG"],
        visitor_country: "US",
        link_import_visible: true,
      },
      reason: "allowed",
      visible: true,
    },
  ])(
    "keeps global/user/country visibility precedence for %j",
    ({ fields, reason, visible }) => {
      const result = parseProcessingPolicy({
        ...processingPolicy(),
        ...fields,
        link_import_disabled_user_ids: ["private-admin-only-user-id"],
      });
      expect(result.linkImportReason).toBe(reason);
      expect(result.linkImportVisible).toBe(visible);
      expect(JSON.stringify(result)).not.toContain(
        "private-admin-only-user-id",
      );
    },
  );
  it("defaults missing visibility to hidden and validates same-recipe ranks only while live", () => {
    const policy = processingPolicy() as Record<string, unknown>;
    delete policy.link_import_visible;
    expect(parseProcessingPolicy(policy).linkImportVisible).toBe(false);
    const job = {
      status: "queued",
      queue: {
        state: "waiting",
        scope: "recipe",
        position: 3,
        jobs_ahead: 2,
        reason: null,
        as_of: "2026-10-09T00:00:00.000Z",
      },
    };
    expect(queueRank(job, true)).toMatchObject({ position: 3, jobsAhead: 2 });
    expect(queueRank(job, false)).toBeNull();
    expect(queueRank({ ...job, status: "processing" }, true)).toBeNull();
    expect(
      queueRank({ ...job, queue: { ...job.queue, scope: "account" } }, true),
    ).toBeNull();
    expect(
      queueRank(
        { ...job, queue: { ...job.queue, reason: "retry_backoff" } },
        true,
      ),
    ).toBeNull();
  });
  it("keeps local processing independent of usage while stale cloud percentages never authorize a command", () => {
    const view: AccountUsageView = {
      connection: "reconnecting",
      authenticated: false,
      libraryReady: false,
      usageState: "stale",
      usage: parseUsage(processingUsage()),
      policyState: "cached",
      policy: parseProcessingPolicy(processingPolicy()),
      errorCode: null,
    };
    const signedOut = {
      state: "signed-out" as const,
      online: false,
      access: { allowed: false, reason: "UNAUTHENTICATED" },
    };
    expect(processingAdmissionPreview("cloud", true, signedOut, view)).toEqual({
      mode: "cloud",
      allowed: false,
      reason: "SIGN_IN_REQUIRED",
      signInRequired: true,
    });
    const signedIn: Pick<AccountView, "state" | "online" | "access"> = {
      state: "signed-in" as const,
      online: true,
      access: { allowed: true, reason: null },
    };
    view.authenticated = true;
    expect(
      processingAdmissionPreview("cloud", true, signedIn, view).allowed,
    ).toBe(false);
    view.usageState = "current";
    view.policyState = "current";
    expect(
      processingAdmissionPreview("cloud", true, signedIn, view).allowed,
    ).toBe(true);
    signedIn.access = { allowed: false, reason: "APP_UPDATE_REQUIRED" };
    expect(
      processingAdmissionPreview("cloud", true, signedIn, view).reason,
    ).toBe("APP_UPDATE_REQUIRED");
  });
  it("bounds owner policy caches, invalidates old-account data and refuses stale cached cloud admission", async () => {
    const h = realtimeFixture();
    const cache = {
      read: vi.fn(async () => null as unknown),
      write: vi.fn(async (_key: string, _value: unknown) => undefined),
    };
    const controller = new AccountUsageController({
      realtime: h.controller,
      cache,
    });
    h.setOwner(h.ownerA);
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1));
    const socket = h.sockets[0]!;
    socket.ready();
    socket.snapshot("s1", processingUsage());
    socket.snapshot("s2", {
      ...processingPolicy(),
      link_import_disabled_user_ids: ["private-admin-id"],
    });
    expect(controller.view().policyState).toBe("current");
    await vi.waitFor(() => expect(cache.write).toHaveBeenCalledOnce());
    const [key, value] = cache.write.mock.calls[0]!;
    expect(key).not.toContain("owner-a");
    expect(JSON.stringify(value)).not.toContain("private-admin-id");
    h.setOwner(h.ownerB);
    expect(controller.view().usage).toBeNull();
    expect(controller.view().policy).toBeNull();
    expect(() =>
      controller.assertCloudSubmission({
        state: "signed-in",
        online: true,
        access: { allowed: true, reason: null },
      }),
    ).toThrow("CLOUD_POLICY_UNAVAILABLE");
    controller.dispose();
    h.controller.dispose();
  });
  it("loads only the matching fresh cache and fences delayed old-owner or app-open responses", async () => {
    const h = realtimeFixture();
    let clock = Date.parse("2026-10-09T00:00:00Z");
    const pending = new Map<string, (value: unknown) => void>();
    const cache = {
      read: vi.fn(
        (key: string) =>
          new Promise<unknown>((resolve) => pending.set(key, resolve)),
      ),
      write: vi.fn(async () => undefined),
    };
    const controller = new AccountUsageController({
      realtime: h.controller,
      cache,
      now: () => clock,
    });
    h.setOwner(h.ownerA);
    const firstKey = cache.read.mock.calls.at(-1)![0];
    h.setOwner(h.ownerB);
    const secondKey = cache.read.mock.calls.at(-1)![0];
    pending.get(firstKey)?.({
      version: 1,
      ownerKey: firstKey,
      savedAt: clock,
      policy: policyToWire(parseProcessingPolicy(processingPolicy())),
    });
    await Promise.resolve();
    expect(controller.view().policy).toBeNull();
    pending.get(secondKey)?.({
      version: 1,
      ownerKey: secondKey,
      savedAt: clock,
      policy: policyToWire(parseProcessingPolicy(processingPolicy())),
    });
    await Promise.resolve();
    expect(controller.view().policyState).toBe("cached");
    clock += 86400001;
    expect(controller.view().policy).toBeNull();
    controller.dispose();
    h.controller.dispose();
  });
});
