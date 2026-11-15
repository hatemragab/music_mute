import {
  CloudProcessingProvider,
  type RealtimeAccess,
} from "../../../../chrome-extension/src/companion/cloud-provider.js";
import type { AccountSessionScope } from "../account/account-controller.js";
import {
  createOutboxApi,
  outboxAccountScope,
  type OutboxAccountPort,
} from "./api.js";
import type { OutboxRecord } from "./model.js";
export interface OutboxCommunityPort {
  link(
    record: OutboxRecord,
    scope: AccountSessionScope,
    signal: AbortSignal,
  ): Promise<string | null>;
}
/** Existing ready shared-owner delivery only; no import/separation intake or model execution. */
export class WindowsOutboxCommunity implements OutboxCommunityPort {
  constructor(
    private readonly options: {
      origin: string;
      installationId: string;
      account: OutboxAccountPort;
      realtime: { cloudLease(scope: AccountSessionScope): RealtimeAccess };
      fetch?: typeof fetch;
    },
  ) {}
  async link(
    record: OutboxRecord,
    scope: AccountSessionScope,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (
      record.kind !== "community-link" ||
      !record.videoId ||
      record.ownerUid !== scope.firebaseUid
    )
      throw new Error("OUTBOX_OWNER_INVALID");
    const api = createOutboxApi(
        this.options.origin,
        this.options.installationId,
        this.options.account,
        scope,
        signal,
        this.options.fetch,
      ),
      provider = new CloudProcessingProvider({
        api: {
          ...api,
          request: async (candidate, path, method, body, active) => {
            if (path !== "/media-imports/cache-deliveries")
              throw new Error("INVALID_API_PATH");
            return api.request(
              candidate,
              path,
              method,
              {
                ...(body as Record<string, unknown>),
                request_id: record.requestId,
              },
              active,
            );
          },
        },
        scope: outboxAccountScope(scope),
        realtime: this.options.realtime.cloudLease(scope),
        signal,
      });
    try {
      const job = await provider.findReusableYouTube(
        record.videoId,
        record.vocals.durationSeconds,
      );
      this.options.account.assertScope(scope);
      signal.throwIfAborted();
      if (!job) return null;
      if (
        !job.output ||
        job.output.sha256 !==
          Buffer.from(record.vocals.sha256, "hex").toString("base64") ||
        job.output.bytes !== record.vocals.bytes
      )
        throw new Error("SOURCE_IDENTITY_MISMATCH");
      return job.id;
    } finally {
      provider.close();
    }
  }
}
