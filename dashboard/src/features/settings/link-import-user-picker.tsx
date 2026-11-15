import { useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type { Page, UserSummary } from "@/api/contracts";
import { ApiError } from "@/api/api-client";
import { useApiClient } from "@/auth/admin-session";
import { CursorPagination } from "@/components/cursor-pagination";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getUser, listUsers } from "@/features/users/users-api";

const selectedPageSize = 20;
const userKey = (id: string) => ["link-import-user", id];
const userLabel = (user: UserSummary) =>
  user.displayName && user.email
    ? `${user.displayName} · ${user.email}`
    : user.email || user.displayName || "Unnamed user";

export function LinkImportUserPicker({
  value,
  onChange,
  disabled = false,
  canReadUsers,
}: {
  value: string[];
  onChange(value: string[]): void;
  disabled?: boolean;
  canReadUsers: boolean;
}) {
  const client = useApiClient();
  const cache = useQueryClient();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{
    query: string;
    cursor: string | null;
    page: Pick<Page<UserSummary>, "items" | "nextCursor">;
  } | null>(null);
  const [selectedPage, setSelectedPage] = useState(0);
  const currentPage = Math.min(
    selectedPage,
    Math.max(0, Math.ceil(value.length / selectedPageSize) - 1),
  );
  const visibleIds = value.slice(
    currentPage * selectedPageSize,
    (currentPage + 1) * selectedPageSize,
  );
  const identities = useQueries({
    queries: visibleIds.map((id) => ({
      queryKey: userKey(id),
      queryFn: async () => {
        const user = await getUser(client, id);
        if (user.id !== id)
          throw new Error(
            "The account response does not match this selection.",
          );
        return user;
      },
      enabled: canReadUsers,
      staleTime: Infinity,
      retry: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
    })),
  });
  const search = useMutation({
    mutationFn: async (input: { query: string; cursor: string | null }) => {
      if (!canReadUsers || disabled)
        throw new Error("Your role cannot select user accounts.");
      let page: Pick<Page<UserSummary>, "items" | "nextCursor">;
      if (input.query.length === 24 && /^[a-f\d]{24}$/i.test(input.query)) {
        try {
          const id = input.query.toLowerCase();
          const user = await getUser(client, id);
          if (user.id !== id)
            throw new Error("The account response does not match this search.");
          page = { items: [user], nextCursor: null };
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
          page = { items: [], nextCursor: null };
        }
      } else {
        page = await listUsers(client, {
          query: input.query || undefined,
          cursor: input.cursor,
        });
      }
      return { ...input, page };
    },
    onSuccess: (response) => {
      for (const user of response.page.items)
        cache.setQueryData(userKey(user.id), user);
      setResult(response);
    },
  });
  const trimmedQuery = query.trim();
  const validQuery =
    !trimmedQuery || (trimmedQuery.length >= 2 && trimmedQuery.length <= 100);
  const maySelect = canReadUsers && !disabled;

  return (
    <section
      className="space-y-3 border-t pt-4"
      aria-label="User link import visibility"
    >
      <div className="space-y-1">
        <Label htmlFor="link-import-users">
          Hide link import for these users
        </Label>
        <p className="text-sm text-muted-foreground">
          Selected accounts cannot see paste-link controls in Android, iOS, Mac,
          or Windows. Removing an account restores the global and country
          settings. File import, existing work, web, and the Chrome panel stay
          available.
        </p>
      </div>
      <div className="space-y-2" aria-label="Selected users">
        <p className="text-sm text-muted-foreground">
          Selected: {value.length}
        </p>
        <div className="flex flex-wrap gap-2">
          {visibleIds.map((id, index) => {
            const identity = identities[index];
            const label =
              canReadUsers && identity.data ? userLabel(identity.data) : id;
            return (
              <div key={id} className="max-w-full space-y-1">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-auto max-w-full whitespace-normal break-all text-left"
                  aria-label={`Remove user ${label} (${id})`}
                  disabled={disabled}
                  onClick={() =>
                    onChange(value.filter((selected) => selected !== id))
                  }
                >
                  {label} ×
                </Button>
                {canReadUsers && identity.isLoading ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    Loading account details…
                  </p>
                ) : null}
                {canReadUsers && identity.isError ? (
                  <p className="text-xs text-muted-foreground">
                    Account details are unavailable. This selection can still be
                    removed.
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
        {value.length > selectedPageSize ? (
          <nav
            aria-label="Selected user pages"
            className="flex items-center gap-2"
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={currentPage === 0}
              onClick={() => setSelectedPage(currentPage - 1)}
            >
              Previous selected users
            </Button>
            <span className="text-xs text-muted-foreground">
              {currentPage * selectedPageSize + 1}–
              {Math.min((currentPage + 1) * selectedPageSize, value.length)} of{" "}
              {value.length}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={(currentPage + 1) * selectedPageSize >= value.length}
              onClick={() => setSelectedPage(currentPage + 1)}
            >
              Next selected users
            </Button>
          </nav>
        ) : null}
      </div>
      {canReadUsers ? (
        <>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (maySelect && validQuery && !search.isPending)
                search.mutate({ query: trimmedQuery, cursor: null });
            }}
          >
            <Input
              id="link-import-users"
              className="min-w-0 flex-1 basis-64"
              placeholder="Search users by email, exact ID, or supported prefix"
              value={query}
              maxLength={100}
              disabled={!maySelect || search.isPending}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={!maySelect || !validQuery || search.isPending}
            >
              Search users
            </Button>
          </form>
          {!validQuery ? (
            <p className="text-xs text-destructive">
              Enter at least two characters, an email, or an exact ID.
            </p>
          ) : null}
          {search.isPending ? <p role="status">Searching users…</p> : null}
          {search.isError ? (
            <p role="alert" className="text-sm text-destructive">
              User search failed. Your selected users are unchanged. Search
              again to retry.
            </p>
          ) : null}
          {result && !search.isError ? (
            <div className="rounded-lg border">
              <div
                className="max-h-64 overflow-y-auto p-3"
                role="group"
                aria-label="User choices"
              >
                {result.page.items.map((user) => (
                  <label
                    key={user.id}
                    className="flex items-start gap-3 rounded p-2 hover:bg-muted/30"
                  >
                    <Checkbox
                      className="mt-1"
                      checked={value.includes(user.id)}
                      disabled={
                        !maySelect ||
                        search.isPending ||
                        (!value.includes(user.id) && value.length >= 1_000)
                      }
                      onCheckedChange={(checked) =>
                        onChange(
                          checked
                            ? [...new Set([...value, user.id])].sort()
                            : value.filter((id) => id !== user.id),
                        )
                      }
                    />
                    <span className="min-w-0 break-words text-sm">
                      {userLabel(user)}
                      <span className="block font-mono text-xs text-muted-foreground">
                        {user.id}
                      </span>
                    </span>
                  </label>
                ))}
                {!result.page.items.length ? (
                  <p className="text-sm text-muted-foreground">
                    No users match this search.
                  </p>
                ) : null}
              </div>
              <CursorPagination
                key={result.query}
                cursor={result.cursor}
                nextCursor={result.page.nextCursor}
                pending={search.isPending || !maySelect}
                onCursorChange={(cursor) =>
                  search.mutate({ query: result.query, cursor })
                }
              />
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Your role cannot search user accounts. Existing selections are shown
          by account ID.
        </p>
      )}
      {value.length >= 1_000 ? (
        <p role="status" className="text-sm text-muted-foreground">
          The limit of 1,000 selected users has been reached. Remove a selection
          before adding another.
        </p>
      ) : null}
    </section>
  );
}
