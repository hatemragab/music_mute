import { type ApiClient, submitWithReceiptReadBack } from "@/api/api-client";
import type {
  AdminAccess,
  AdminRole,
  Page,
  RevisionCommand,
} from "@/api/contracts";
import { withQuery } from "@/api/query-string";

export const listAdministrators = (
  client: ApiClient,
  options: { active?: boolean; cursor?: string | null; limit?: number } = {},
) => client.get<Page<AdminAccess>>(withQuery("/admin/access", options));

const readAdministrator = async (client: ApiClient, uid: string) => {
  let cursor: string | null = null;
  let pageCount = 0;
  const visited = new Set<string>();
  do {
    if (pageCount++ >= 100) break;
    const page = await listAdministrators(client, { limit: 100, cursor });
    const administrator = page.items.find((item) => item.uid === uid);
    if (administrator) return administrator;
    cursor = page.nextCursor;
    if (cursor && visited.has(cursor)) break;
    if (cursor) visited.add(cursor);
  } while (cursor);
  throw new Error("The committed administrator could not be found.");
};

export const addAdministrator = (
  client: ApiClient,
  input: {
    verifiedEmail: string;
    role: AdminRole;
    operationId: string;
    reason: string;
  },
) =>
  submitWithReceiptReadBack({
    client,
    operationId: input.operationId,
    submit: () => client.post<AdminAccess>("/admin/access", input),
    readResult: (receipt) =>
      readAdministrator(client, receipt.resourceId ?? ""),
  });

export const updateAdministrator = (
  client: ApiClient,
  uid: string,
  input: RevisionCommand & { role?: AdminRole; active?: boolean },
) =>
  submitWithReceiptReadBack({
    client,
    operationId: input.operationId,
    submit: () =>
      client.patch<AdminAccess>(
        `/admin/access/${encodeURIComponent(uid)}`,
        input,
      ),
    readResult: (receipt) =>
      readAdministrator(client, receipt.resourceId ?? uid),
  });
