import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { WindowsBrowserService } from "../src/main/browser/service.js";
import { BrowserAccountCleanupUnconfirmed } from "../src/main/browser/account-bridge.js";

// Actual service lifecycle with receiving-only ports. These tests confer no
// Store package, Chrome process, account or kernel cleanup authority.
function fixture(store = true) {
  type Options = ConstructorParameters<typeof WindowsBrowserService>[0];
  const accountClose = vi.fn(async () => {}),
    mediaClose = vi.fn(async () => {}),
    personal = vi.fn(
      async (
        command: Parameters<NonNullable<Options["session"]>["personal"]>[0],
      ) => ({
        version: 1 as const,
        requestId: command.requestId,
        ok: true,
      }),
    );
  const unexpected = async (): Promise<never> => {
    throw new Error("UNEXPECTED_RECEIVING_OPERATION");
  };
  const account: NonNullable<Options["account"]> = {
    ownerId: randomUUID(),
    command: unexpected,
    start: unexpected,
    wait: unexpected,
    playbackStarted: unexpected,
    close: accountClose,
  };
  const service = new WindowsBrowserService({
    ...(store ? { distribution: "microsoft-store" as const } : {}),
    session: { personal },
    account,
    media: { issue: unexpected, close: mediaClose },
    write: async () => {},
    onDisconnected: () => {},
  });
  return { service, accountClose, mediaClose, personal };
}

it("retains the original Store account close failure and still retires media", async () => {
  const f = fixture(),
    original = new BrowserAccountCleanupUnconfirmed(
      new Error("RECEIVING_UNKNOWN"),
    );
  f.accountClose.mockRejectedValue(original);
  const closing = f.service.close();
  await expect(closing).rejects.toMatchObject({
    message: "BROWSER_CLEANUP_UNCONFIRMED",
    errors: [original],
  });
  expect(f.service.close()).toBe(closing);
  await expect(f.service.close()).rejects.toThrow(
    "BROWSER_CLEANUP_UNCONFIRMED",
  );
  expect(f.personal).toHaveBeenCalledOnce();
  expect(f.accountClose).toHaveBeenCalledOnce();
  expect(f.mediaClose).toHaveBeenCalledOnce();
});

it("joins the same in-flight Store close instead of claiming a second early close", async () => {
  const f = fixture();
  let finish!: () => void;
  f.accountClose.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const first = f.service.close(),
    second = f.service.close();
  expect(second).toBe(first);
  let completed = false;
  void second.then(() => {
    completed = true;
  });
  await vi.waitFor(() => expect(f.accountClose).toHaveBeenCalledOnce());
  expect(completed).toBe(false);
  finish();
  await first;
  expect(f.mediaClose).toHaveBeenCalledOnce();
  expect(f.personal.mock.calls[0]![0]).toMatchObject({
    action: "detach",
    ownerId: f.service.ownerId,
  });
});

it("retains rejected Chrome detach and media cleanup independently", async () => {
  const f = fixture(),
    original = new Error("MEDIA_RECEIVING_UNKNOWN");
  f.personal.mockResolvedValue({
    version: 1,
    requestId: randomUUID(),
    ok: false,
  });
  f.mediaClose.mockRejectedValue(original);
  const failure = await f.service.close().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toHaveLength(2);
  expect((failure as AggregateError).errors[0]).toMatchObject({
    message: "BROWSER_OWNER_RETIREMENT_UNCONFIRMED",
  });
  expect((failure as AggregateError).errors[1]).toBe(original);
  expect(f.accountClose).toHaveBeenCalledOnce();
});

it("preserves the existing legacy handling of account close failures", async () => {
  const f = fixture(false);
  f.accountClose.mockRejectedValue(new Error("LEGACY_RECEIVING_CLOSE"));
  await expect(f.service.close()).resolves.toBeUndefined();
  expect(f.mediaClose).toHaveBeenCalledOnce();
});
