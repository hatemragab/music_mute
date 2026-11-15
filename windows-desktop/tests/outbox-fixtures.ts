import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import {
  OutboxController,
  type OutboxOptions,
} from "../src/main/outbox/controller.js";
import {
  JournalOutboxStore,
  type OutboxJournalFiles,
} from "../src/main/outbox/store.js";
import { stageOutbox, type OutboxRecord } from "../src/main/outbox/model.js";
import type { AccountSessionScope } from "../src/main/account/account-controller.js";
import type { AccountView } from "../src/shared/account-contracts.js";
import type { OutboxMediaPort } from "../src/main/outbox/media.js";
import type { LocalLibraryEntry } from "../src/main/library/model.js";
import { accountView } from "./fleet-fixtures.js";
import { ownerA } from "./realtime-fixtures.js";
export const outboxInstallation = "d7ea7de6-52e9-4b96-8834-3b517941bdb0";
export const syncId = "0123456789abcdef01234567",
  jobId = "0123456789abcdef01234568";
export function localEntry(video = false): LocalLibraryEntry {
  return {
    personalJobId: randomUUID(),
    catalog: {
      cache_key: "a".repeat(64),
      operation_id: randomUUID(),
      source_kind: video ? "url" : "file",
      source_title: "Fixture track",
      duration_seconds: 60,
      source_duration_seconds: 60,
      trim_enabled: false,
      bytes: 500,
      sha256: "c".repeat(64),
      created_at: Date.now(),
      updated_at: Date.now(),
      ...(video ? { video_id: "bZxrIoCPsOc" } : {}),
    },
    original: {
      id: randomUUID(),
      kind: "original",
      name: "input.m4a",
      bytes: 1000,
      sha256: "b".repeat(64),
      durationSeconds: 60,
      contentType: "audio/mp4",
    },
    vocals: {
      id: randomUUID(),
      kind: "vocals",
      name: "input.m4a",
      bytes: 500,
      sha256: "c".repeat(64),
      durationSeconds: 60,
      contentType: "audio/mpeg",
    },
  };
}
export async function outboxFixture(saved = new Map<string, OutboxRecord>()) {
  let scope: AccountSessionScope | null = ownerA,
    view = { ...accountView(), online: false },
    time = Date.now(),
    serial: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(view: AccountView) => void>(),
    retained = new Set<string>(),
    server = new Map<
      string,
      { body: string; committed: boolean; uploads: Set<string> }
    >(),
    calls: {
      path: string;
      body: Record<string, unknown>;
      bearer: string | null;
    }[] = [];
  const files: OutboxJournalFiles = {
      list: vi.fn(async () =>
        [...saved.values()].map((r) => structuredClone(r)),
      ),
      write: vi.fn(async (record) => {
        saved.set(record.requestId, structuredClone(record));
      }),
      locked: (action) => {
        const task = serial.then(action);
        serial = task.catch(() => {});
        return task;
      },
    },
    store = new JournalOutboxStore(files, outboxInstallation);
  const grant = (kind: string) => {
    const artifact =
        kind === "original"
          ? { type: "audio/mp4", hash: "b" }
          : { type: "audio/mpeg", hash: "c" },
      sha = Buffer.from(artifact.hash.repeat(64), "hex").toString("base64");
    return {
      method: "PUT",
      url: `https://fixture.r2.cloudflarestorage.com/${kind}?signature=secret`,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      headers: {
        "Content-Type": artifact.type,
        "If-None-Match": "*",
        "x-amz-checksum-sha256": sha,
        "x-amz-meta-sha256": sha,
      },
    };
  };
  const sync = (requestId: string, ready = false, expiredGrants = false) => ({
    sync_id: syncId,
    job_id: jobId,
    request_id: requestId,
    profile_id: "kim-vocal-2-full-timeline-v1",
    status: ready ? "ready" : "awaiting_upload",
    committed: ready,
    upload_grants: ready
      ? null
      : {
          original: {
            ...grant("original"),
            ...(expiredGrants
              ? { expires_at: new Date(Date.now() - 1).toISOString() }
              : {}),
          },
          vocals: grant("vocals"),
        },
  });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname,
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({
      path,
      body,
      bearer: new Headers(init?.headers).get("authorization"),
    });
    if (path === "/local-media-syncs") {
      const id = body.request_id as string,
        prior = server.get(id);
      if (prior && prior.body !== JSON.stringify(body))
        return Response.json({ code: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
      if (!prior)
        server.set(id, {
          body: JSON.stringify(body),
          committed: false,
          uploads: new Set(),
        });
      return Response.json(sync(id, server.get(id)!.committed));
    }
    const id = [...server.keys()][0]!;
    if (path.endsWith("/upload-grants"))
      return Response.json(sync(id, server.get(id)!.committed));
    if (path.endsWith("/completions")) {
      const remote = server.get(id)!;
      if (remote.uploads.size !== 2)
        return Response.json({ code: "UPLOAD_NOT_READY" }, { status: 409 });
      remote.committed = true;
      return Response.json(sync(id, true));
    }
    throw new Error("unsupported fixture route");
  });
  const media: OutboxMediaPort = {
    describe: vi.fn(
      async (entry, owner, installation, requestId, kind, now, context) => {
        context.assertCurrent();
        return stageOutbox(entry, owner, installation, requestId, kind, now);
      },
    ),
    retain: vi.fn(async (record, context) => {
      context.assertCurrent();
      retained.add(record.requestId);
    }),
    verify: vi.fn(async (record, context) => {
      context.assertCurrent();
      if (!retained.has(record.requestId))
        throw new Error("OUTBOX_ARTIFACT_INVALID");
    }),
    upload: vi.fn(async (record, artifact, _grant, context) => {
      context.assertCurrent();
      server
        .get(record.requestId)!
        .uploads.add(artifact === record.original ? "original" : "vocals");
    }),
    release: vi.fn(async (record) => {
      retained.delete(record.requestId);
    }),
  };
  const account = {
      sessionScope: () => scope,
      assertScope: (owner: AccountSessionScope) => {
        if (
          !scope ||
          scope.firebaseUid !== owner.firebaseUid ||
          scope.generation !== owner.generation
        )
          throw new Error("ACCOUNT_CHANGED");
      },
      authorization: vi.fn(async () => "header.payload.synthetic-private"),
      view: () => view,
      subscribe: (listener: (view: AccountView) => void) => {
        listeners.add(listener);
        listener(view);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    attached = new Map<string, string>(),
    catalog = {
      attach: vi.fn(
        async (owner: AccountSessionScope, local: string, id: string) => {
          account.assertScope(owner);
          attached.set(`${owner.firebaseUid}:${local}`, id);
        },
      ),
    },
    community = { link: vi.fn(async () => jobId as string | null) };
  const options: OutboxOptions = {
    origin: "https://api.example.test",
    installationId: outboxInstallation,
    account,
    store,
    media,
    community,
    catalog,
    fetch: fetcher,
    now: () => time,
    random: () => 0,
  };
  let controller = new OutboxController(options);
  await controller.restore();
  return {
    get controller() {
      return controller;
    },
    options,
    account,
    files,
    store,
    saved,
    server,
    calls,
    media,
    catalog,
    community,
    retained,
    attached,
    fetcher,
    sync,
    grant,
    scope: () => scope,
    advance: (ms: number) => {
      time += ms;
    },
    online: (online = true) => {
      view = { ...view, online };
    },
    setOwner: async (owner: AccountSessionScope | null) => {
      scope = owner;
      view = {
        ...view,
        state: owner ? "signed-in" : "signed-out",
        user: owner ? accountView().user : null,
      };
      for (const listener of listeners) listener(view);
      await controller.setScope(owner);
    },
    run: async () => {
      view = { ...view, online: true };
      await controller.savePending();
    },
    reopen: async () => {
      view = { ...view, online: false };
      await controller.dispose();
      controller = new OutboxController(options);
      await controller.restore();
    },
  };
}
