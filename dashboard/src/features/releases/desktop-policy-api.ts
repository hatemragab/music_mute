import { submitWithReceiptReadBack, type ApiClient } from "@/api/api-client";
import type { DesktopUpdatePolicy } from "@/api/contracts";
export interface DesktopPolicyCommand {
  expectedRevision: number;
  operationId: string;
  reason: string;
  platforms: Partial<Pick<DesktopUpdatePolicy, "macos" | "windows">>;
}
export const getDesktopUpdatePolicy = (client: ApiClient) =>
  client.get<DesktopUpdatePolicy>("/admin/update-policy/desktop");
export function updateDesktopPolicy(
  client: ApiClient,
  input: DesktopPolicyCommand,
) {
  return submitWithReceiptReadBack<{
    policy: DesktopUpdatePolicy;
    appliedRevision: number;
    operationId: string;
    replayed: boolean;
  }>({
    client,
    operationId: input.operationId,
    submit: () => client.patch("/admin/update-policy/desktop", input),
    readResult: async (receipt) => {
      if (
        !Number.isSafeInteger(receipt.revision) ||
        Number(receipt.revision) < 1
      )
        throw new Error("Desktop policy receipt is incomplete.");
      return {
        policy: await getDesktopUpdatePolicy(client),
        appliedRevision: receipt.revision as number,
        operationId: input.operationId,
        replayed: true,
      };
    },
  });
}
