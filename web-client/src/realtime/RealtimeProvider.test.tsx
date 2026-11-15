import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "../api/client";
import type { JobListView, JobView } from "../api/types";
import { realtimeFixture } from "../../tests/realtime-fixture";
import { RealtimeProvider, useLiveJobs } from "./RealtimeProvider";

const auth = vi.hoisted(() => ({
  user: { uid: "owner-a" },
  api: {},
  retry: vi.fn(),
}));
vi.mock("../auth/AuthProvider", () => ({
  useSignedIn: () => auth,
  useAuth: () => auth,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  auth.user = { uid: "owner-a" };
});

function songs(count: number, owner = "owner-a"): JobView[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${owner}-${index}`,
    status: "ready",
    displayName: `Song ${index}`,
  })) as JobView[];
}

function library(initial: JobView[]) {
  let items = initial;
  let failCursor: string | null = null;
  const reads: Record<string, string>[] = [];
  const fixture = realtimeFixture((resource, params): JobListView => {
    expect(resource).toBe("jobs");
    expect(params.limit).toBe("20");
    expect(params.status).toBe("ready");
    reads.push(params);
    if (params.cursor && params.cursor === failCursor)
      throw new ApiError(503, "SERVICE_UNAVAILABLE");
    const from = params.cursor
      ? items.findIndex((song) => song.id === params.cursor) + 1
      : 0;
    const page = items.slice(from, from + 20);
    return {
      items: page,
      nextCursor: from + 20 < items.length ? page.at(-1)!.id : null,
    };
  });
  return {
    ...fixture,
    reads,
    setItems: (next: JobView[]) => {
      items = next;
    },
    fail: (cursor: string | null) => {
      failCursor = cursor;
    },
  };
}

function mount(initial: ReturnType<typeof library>) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let fixture = initial;
  const hook = renderHook(() => useLiveJobs("ready"), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={cache}>
        <RealtimeProvider client={fixture.client}>{children}</RealtimeProvider>
      </QueryClientProvider>
    ),
  });
  return {
    ...hook,
    switchOwner: (owner: string, next: typeof fixture) => {
      auth.user = { uid: owner };
      fixture = next;
      hook.rerender();
    },
  };
}

test("Library follows owner cursors beyond ten live pages without repeating or losing songs", async () => {
  const expected = songs(245);
  const fixture = library(expected);
  const active = new Map<string, number>();
  const watch = fixture.client.watch.bind(fixture.client);
  vi.spyOn(fixture.client, "watch").mockImplementation(
    (resource, params, listener) => {
      const key = params.cursor ?? "first";
      active.set(key, (active.get(key) ?? 0) + 1);
      const off = watch(resource, params, listener);
      return () => {
        active.set(key, active.get(key)! - 1);
        if (!active.get(key)) active.delete(key);
        off();
      };
    },
  );
  const hook = mount(fixture);
  await waitFor(() => expect(hook.result.current.data?.pages).toHaveLength(1));
  for (let page = 2; page <= 13; page++) {
    await act(async () => {
      await hook.result.current.fetchNextPage();
    });
    await waitFor(() =>
      expect(hook.result.current.data?.pages).toHaveLength(page),
    );
  }
  expect(hook.result.current.data?.pages.flatMap((page) => page.items)).toEqual(
    expected,
  );
  expect(hook.result.current.hasNextPage).toBe(false);
  await waitFor(() => expect(active.size).toBe(10));
  expect([...active.keys()]).toEqual([
    "first",
    ...[79, 99, 119, 139, 159, 179, 199, 219, 239].map(
      (index) => `owner-a-${index}`,
    ),
  ]);
});

test("a failed next page preserves loaded songs and retries the same cursor", async () => {
  const expected = songs(45);
  const fixture = library(expected);
  const hook = mount(fixture);
  await waitFor(() => expect(hook.result.current.data?.pages).toHaveLength(1));
  await waitFor(() => expect(hook.result.current.isFetching).toBe(false));
  fixture.fail("owner-a-19");
  await act(async () => {
    await hook.result.current.fetchNextPage();
  });
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(hook.result.current.data?.pages.flatMap((page) => page.items)).toEqual(
    expected.slice(0, 20),
  );
  expect(hook.result.current.hasNextPage).toBe(true);
  fixture.fail(null);
  await act(async () => {
    await hook.result.current.fetchNextPage();
  });
  await waitFor(() => expect(hook.result.current.isError).toBe(false));
  expect(hook.result.current.data?.pages.flatMap((page) => page.items)).toEqual(
    expected.slice(0, 40),
  );
  expect(
    fixture.reads
      .filter((params) => params.cursor)
      .every((params) => params.cursor === "owner-a-19"),
  ).toBe(true);
});

test("reconnect replaces shifted page boundaries before loading older songs again", async () => {
  const expected = songs(45);
  const fixture = library(expected);
  const hook = mount(fixture);
  await waitFor(() => expect(hook.result.current.data?.pages).toHaveLength(1));
  await act(async () => {
    await hook.result.current.fetchNextPage();
  });
  await waitFor(() => expect(hook.result.current.data?.pages).toHaveLength(2));
  const inserted = { ...expected[0]!, id: "new-song" };
  fixture.setItems([inserted, ...expected]);
  act(() => fixture.client.reconnect());
  await waitFor(() => expect(hook.result.current.data?.pages).toHaveLength(1));
  expect(hook.result.current.data?.pages[0]?.items[0]?.id).toBe("new-song");
  await act(async () => {
    await hook.result.current.fetchNextPage();
  });
  await waitFor(() => expect(hook.result.current.data?.pages).toHaveLength(2));
  await act(async () => {
    await hook.result.current.fetchNextPage();
  });
  await waitFor(() => expect(hook.result.current.data?.pages).toHaveLength(3));
  expect(hook.result.current.data?.pages.flatMap((page) => page.items)).toEqual(
    [inserted, ...expected],
  );
  expect(hook.result.current.hasNextPage).toBe(false);
});

test("changing accounts starts at the new owner's first page with no previous songs or cursor", async () => {
  const first = library(songs(45));
  const hook = mount(first);
  await waitFor(() => expect(hook.result.current.data?.pages).toHaveLength(1));
  await act(async () => {
    await hook.result.current.fetchNextPage();
  });
  await waitFor(() => expect(hook.result.current.data?.pages).toHaveLength(2));
  const expected = songs(25, "owner-b");
  const second = library(expected);
  act(() => hook.switchOwner("owner-b", second));
  await waitFor(() =>
    expect(hook.result.current.data?.pages[0]?.items[0]?.id).toBe("owner-b-0"),
  );
  expect(hook.result.current.data?.pageParams).toEqual([undefined]);
  await act(async () => {
    await hook.result.current.fetchNextPage();
  });
  await waitFor(() => expect(hook.result.current.data?.pages).toHaveLength(2));
  expect(hook.result.current.data?.pages.flatMap((page) => page.items)).toEqual(
    expected,
  );
  expect(
    second.reads.every(
      (params) => !params.cursor || params.cursor.startsWith("owner-b-"),
    ),
  ).toBe(true);
});
