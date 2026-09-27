import { expect, test, type WebSocketRoute } from "@playwright/test";

test("public history receives pushed queue changes without polling", async ({
  page,
}) => {
  let socket: WebSocketRoute;
  let ticketCount = 0;
  let connectionCount = 0;
  const subscriptions = new Map<
    string,
    { resource: string; sequence: number }
  >();
  let position = 3;
  const job = () => ({
    id: "0123456789abcdef01234567",
    request_id: "fixture",
    display_name: "Queued audio fixture",
    status: "queued",
    source_kind: "file",
    created_at: "2026-09-26T10:00:00Z",
    updated_at: "2026-09-26T10:00:00Z",
    queue: {
      state: "waiting",
      position,
      jobs_ahead: position - 1,
      scope: "recipe",
      reason: null,
      as_of: "2026-09-26T10:00:00Z",
    },
  });
  const publish = () => {
    for (const [id, sub] of subscriptions)
      socket.send(
        JSON.stringify({
          type: "snapshot",
          protocol_version: 1,
          stream_id: "browser",
          subscription_id: id,
          sequence: ++sub.sequence,
          data:
            sub.resource === "jobs"
              ? { items: [job()], next_cursor: null }
              : sub.resource === "job"
                ? job()
                : { accept_new_jobs: true, limits: {} },
        }),
      );
  };
  await page.route("http://127.0.0.1:3000/realtime-tickets", (route) => {
    ticketCount++;
    return route.fulfill({
      status: 201,
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        ticket: "a".repeat(43),
        path: "/realtime/socket",
        protocol: "musicmute.realtime.v1",
      }),
    });
  });
  await page.routeWebSocket("ws://127.0.0.1:3000/realtime/socket", (route) => {
    connectionCount++;
    socket = route;
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type === "subscribe") {
        subscriptions.set(command.subscription_id, {
          resource: command.resource,
          sequence: 0,
        });
        publish();
      }
      if (command.type === "unsubscribe")
        subscriptions.delete(command.subscription_id);
    });
    route.send(
      JSON.stringify({
        type: "ready",
        protocol_version: 1,
        stream_id: "browser",
      }),
    );
  });
  const reads: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      /^http:\/\/127.0.0.1:3000/.test(request.url())
    )
      reads.push(request.url());
  });
  await page.clock.install();
  await page.goto("/tests/preview.html?network-realtime");
  await expect(page.getByText("Queued audio fixture").first()).toBeVisible();
  await expect(page.getByText(/#3/).first()).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(120_000);
  expect(ticketCount).toBe(1);
  expect(connectionCount).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  socket.send(JSON.stringify({ type: "ping" }));
  await page.clock.fastForward(30_000);
  expect(ticketCount).toBe(1);
  expect(connectionCount).toBe(1);
  position = 1;
  publish();
  await expect(page.getByText(/#1/).first()).toBeVisible();
  await page.clock.fastForward(31_000);
  await page.context().setOffline(true);
  await expect(page.getByText(/#1/)).toHaveCount(0);
  position = 2;
  await page.context().setOffline(false);
  await expect(page.getByText(/#2/).first()).toBeVisible();
  expect(reads).toEqual([]);
  await expect(page.getByRole("button", { name: /^Refresh$/ })).toHaveCount(0);
});
