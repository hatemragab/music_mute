import { type ApiClient, submitWithReceiptReadBack } from "@/api/api-client";
import type { ProcessingSettings, RevisionCommand } from "@/api/contracts";

export const getProcessingSettings = (client: ApiClient) =>
  client.get<ProcessingSettings>("/admin/settings/processing");

export const updateProcessingSettings = (
  client: ApiClient,
  settings: Omit<ProcessingSettings, "revision" | "updatedAt"> &
    RevisionCommand,
) =>
  submitWithReceiptReadBack({
    client,
    operationId: settings.operationId,
    submit: () =>
      client.put<ProcessingSettings>("/admin/settings/processing", settings),
    readResult: () => getProcessingSettings(client),
  });
