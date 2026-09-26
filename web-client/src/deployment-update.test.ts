import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { reloadBlocked, watchDeployment } from "./deployment-update";

const first = "11111111-1111-4111-8111-111111111111";
const next = "22222222-2222-4222-8222-222222222222";
const html = (version: string) =>
  `<meta name="musicmute-build" content="${version}">`;
const page = (version: string) =>
  new Response(html(version), { headers: { "content-type": "text/html" } });
let stop = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  document.head.innerHTML = html(first);
  document.body.innerHTML = "";
  sessionStorage.clear();
});
afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("reloads once when deployed HTML differs, preserving the current URL", async () => {
  const reload = vi.fn();
  const fetchPage = vi.fn().mockResolvedValue(page(next));
  stop = watchDeployment({ fetchPage, reload });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(fetchPage).toHaveBeenCalledWith(
    expect.stringContaining("/?deployment-check="),
    expect.objectContaining({ cache: "no-store", credentials: "omit" }),
  );
});

test("keeps checking after unchanged HTML, failures and invalid deployment pages", async () => {
  const reload = vi.fn();
  const fetchPage = vi
    .fn()
    .mockResolvedValueOnce(page(first))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
    .mockResolvedValueOnce(page("invalid"))
    .mockResolvedValueOnce(page(next));
  stop = watchDeployment({ fetchPage, reload });
  await vi.advanceTimersByTimeAsync(180_000);
  expect(reload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reload).toHaveBeenCalledOnce();
});

test("defers an update while local work is protected, then rechecks on focus", async () => {
  const reload = vi.fn();
  document.body.innerHTML = '<div data-reload-blocked="true"></div>';
  stop = watchDeployment({
    fetchPage: vi.fn().mockImplementation(() => Promise.resolve(page(next))),
    reload,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(reload).not.toHaveBeenCalled();
  document.body.innerHTML = "";
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(reload).toHaveBeenCalledOnce();
});

test("protects form drafts and selected files", () => {
  document.body.innerHTML = '<input value="draft URL">';
  expect(reloadBlocked()).toBe(true);
  document.body.innerHTML = "<textarea>draft</textarea>";
  expect(reloadBlocked()).toBe(true);
  document.body.innerHTML = '<input type="range" value="50">';
  expect(reloadBlocked()).toBe(false);
});

test("prevents reload loops for the same loaded build", async () => {
  sessionStorage.setItem("musicmute.deployment-reload", first);
  const reload = vi.fn();
  stop = watchDeployment({
    fetchPage: vi.fn().mockResolvedValue(page(next)),
    reload,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(reload).not.toHaveBeenCalled();
});

test("does not poll development HTML and cleans up pending checks", async () => {
  document.head.innerHTML = "";
  const fetchPage = vi.fn();
  stop = watchDeployment({ fetchPage });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetchPage).not.toHaveBeenCalled();
  document.head.innerHTML = html(first);
  const reload = vi.fn();
  stop = watchDeployment({
    fetchPage: vi.fn().mockResolvedValue(page(next)),
    reload,
  });
  stop();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(reload).not.toHaveBeenCalled();
});

test("avoids reload storms across alternating deployment replicas", async () => {
  sessionStorage.setItem("musicmute.deployment-reload.at", String(Date.now()));
  const reload = vi.fn();
  stop = watchDeployment({
    fetchPage: vi.fn().mockImplementation(() => Promise.resolve(page(next))),
    reload,
  });
  await vi.advanceTimersByTimeAsync(240_000);
  expect(reload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reload).toHaveBeenCalledOnce();
});

test("waits until a hidden tab becomes visible", async () => {
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const fetchPage = vi.fn().mockResolvedValue(page(next));
  const reload = vi.fn();
  stop = watchDeployment({ fetchPage, reload });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchPage).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(reload).toHaveBeenCalledOnce();
});
