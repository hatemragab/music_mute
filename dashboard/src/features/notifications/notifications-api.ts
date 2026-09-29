import { type ApiClient, submitWithReceiptReadBack } from "@/api/api-client";
export interface NotificationCampaign {
  id: string;
  title: string;
  body: string;
  reason: string;
  actorUid: string;
  audience: "all_users";
  state: "queued" | "sending" | "completed";
  targetsFrozen: boolean;
  counts: {
    pending: number;
    sent: number;
    failed: number;
    invalid: number;
    ineligible: number;
  };
  createdAt: string;
  completedAt: string | null;
}
export function sendNotification(
  client: ApiClient,
  input: { title: string; body: string; reason: string; operationId: string },
) {
  return submitWithReceiptReadBack<NotificationCampaign>({
    client,
    operationId: input.operationId,
    submit: () => client.post("/admin/notifications", input),
    readResult: (receipt) =>
      client.get(
        `/admin/notifications/${encodeURIComponent(receipt.resourceId!)}`,
      ),
  });
}
