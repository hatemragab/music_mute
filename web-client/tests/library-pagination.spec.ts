import { expect, test } from "@playwright/test";

test("Library loads every ready song beyond ten pages, retries errors, and recovers shifted cursors on reconnect", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const song = (index: number) => ({
    id: index.toString(16).padStart(24, "0"),
    display_name: `Library song ${index}`,
    status: "ready",
    source_kind: "url",
    created_at: new Date(Date.UTC(2026, 9, 17) - index * 1000).toISOString(),
    updated_at: "2026-10-17T00:00:00.000Z",
    can_download_input: true,
    can_download_output: true,
    input: { extension: "mp3", bytes: 1024, duration_seconds: 10 },
    error: null,
    processing_progress: null,
  });
  let items = Array.from({ length: 245 }, (_, index) => song(index + 1));
  const subscriptions: Record<string, string>[] = [];
  const httpReads: string[] = [];
  let failNextPage = true;
  let connections = 0;
  let disconnect = () => {};
  const cursorFor = (item: ReturnType<typeof song>) =>
    Buffer.from(
      JSON.stringify({
        createdAt: item.created_at,
        id: item.id,
      }),
    ).toString("base64url");
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      request.url().startsWith("http://127.0.0.1:3000/")
    )
      httpReads.push(request.url());
  });
  await page.route("http://127.0.0.1:3000/realtime-tickets", (route) =>
    route.fulfill({
      status: 201,
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        ticket: "a".repeat(43),
        path: "/realtime/socket",
        protocol: "musicmute.realtime.v1",
      }),
    }),
  );
  await page.routeWebSocket("ws://127.0.0.1:3000/realtime/socket", (socket) => {
    const stream = `library-${++connections}`;
    disconnect = () =>
      socket.close({ code: 1012, reason: "Synthetic reconnect" });
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type !== "subscribe") return;
      const params = command.params as Record<string, string>;
      if (command.resource === "jobs") subscriptions.push(params);
      if (
        command.resource === "jobs" &&
        params.status === "ready" &&
        params.cursor &&
        failNextPage
      ) {
        failNextPage = false;
        socket.send(
          JSON.stringify({
            type: "subscription_error",
            stream_id: stream,
            subscription_id: command.subscription_id,
            status: 503,
            code: "SERVICE_UNAVAILABLE",
          }),
        );
        return;
      }
      let data: unknown = { accept_new_jobs: true, limits: {} };
      if (command.resource === "jobs") {
        const after = params.cursor
          ? JSON.parse(Buffer.from(params.cursor, "base64url").toString()).id
          : null;
        const start = after
          ? items.findIndex((item) => item.id === after) + 1
          : 0;
        const visible = items.slice(start, start + 20);
        data = {
          items:
            params.status === "ready"
              ? visible
              : [
                  {
                    ...song(999),
                    status: "processing",
                    can_download_output: false,
                  },
                ],
          next_cursor:
            params.status === "ready" && start + 20 < items.length
              ? cursorFor(visible.at(-1)!)
              : null,
        };
      }
      socket.send(
        JSON.stringify({
          type: "snapshot",
          protocol_version: 1,
          stream_id: stream,
          subscription_id: command.subscription_id,
          sequence: 1,
          data,
        }),
      );
    });
    socket.send(
      JSON.stringify({ type: "ready", protocol_version: 1, stream_id: stream }),
    );
  });
  await page.goto("/tests/preview.html?network-realtime");
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "Library", exact: true })
    .click();
  const rows = page.locator(".library-item");
  const more = page.getByRole("button", { name: "Load more", exact: true });
  await expect(rows).toHaveCount(20);
  await more.click();
  await expect(page.getByRole("alert")).toContainText("Request failed");
  await expect(rows).toHaveCount(20);
  await expect(more).toBeEnabled();
  await more.click();
  await expect(rows).toHaveCount(40);
  for (let count = 60; count <= 240; count += 20) {
    await more.click();
    await expect(rows).toHaveCount(count);
  }
  await more.click();
  await expect(rows).toHaveCount(245);
  await expect(more).toHaveCount(0);
  const links = await rows
    .locator("h2 a")
    .evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute("href")),
    );
  expect(new Set(links).size).toBe(245);
  expect(links).toEqual(items.map((item) => `/jobs/${item.id}`));
  const pageTwoCursor = cursorFor(items[19]!);
  expect(
    subscriptions.filter(
      (params) => params.status === "ready" && params.cursor === pageTwoCursor,
    ).length,
  ).toBeGreaterThanOrEqual(2);
  expect(
    subscriptions
      .filter((params) => params.status === "ready")
      .every((params) => params.limit === "20"),
  ).toBe(true);
  expect(
    await page.getByText("Library song 999", { exact: true }).count(),
  ).toBe(0);

  const beforeReconnect = connections;
  items = [song(0), ...items];
  disconnect();
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toContainText("Library song 0");
  await more.click();
  await expect(rows).toHaveCount(40);
  const recovered = await rows
    .locator("h2 a")
    .evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute("href")),
    );
  expect(recovered).toEqual(
    items.slice(0, 40).map((item) => `/jobs/${item.id}`),
  );
  expect(connections).toBe(beforeReconnect + 1);
  expect(httpReads).toEqual([]);
});
