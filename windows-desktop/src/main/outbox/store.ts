import { lstat, readdir } from "node:fs/promises";
import { win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HostContext } from "../host-context.js";
import {
  readPrivateBytes,
  writePrivateAtomic,
} from "../prepare/private-files.js";
import {
  OUTBOX_MAX_RECORDS,
  OUTBOX_MAX_RECORD_BYTES,
  OUTBOX_ORIGINAL_BUDGET,
  OUTBOX_VOCALS_BUDGET,
  OUTBOX_UUID,
  outboxOwner,
  outboxRoot,
  artifactDeclaration,
  parseOutboxRecord,
  type OutboxRecord,
} from "./model.js";
export interface OutboxStore {
  list(uid?: string): Promise<OutboxRecord[]>;
  create(record: OutboxRecord): Promise<OutboxRecord>;
  update(
    expected: OutboxRecord,
    patch: Partial<OutboxRecord>,
  ): Promise<OutboxRecord>;
}
export interface OutboxJournalFiles {
  list(): Promise<unknown[]>;
  write(record: OutboxRecord): Promise<void>;
  locked<T>(action: () => Promise<T>): Promise<T>;
}
export class JournalOutboxStore implements OutboxStore {
  constructor(
    private readonly files: OutboxJournalFiles,
    private readonly installationId: string,
  ) {}
  async list(uid?: string): Promise<OutboxRecord[]> {
    const records = (await this.files.list()).map((r) =>
      parseOutboxRecord(r, this.installationId),
    );
    if (
      records.length > OUTBOX_MAX_RECORDS ||
      new Set(records.map((r) => `${r.ownerUid}:${r.requestId}`)).size !==
        records.length
    )
      throw new Error("OUTBOX_RECORD_LIMIT");
    return records.filter((r) => uid === undefined || r.ownerUid === uid);
  }
  async create(record: OutboxRecord): Promise<OutboxRecord> {
    const checked = parseOutboxRecord(record, this.installationId);
    return this.files.locked(async () => {
      const all = await this.list(),
        existing = all.find(
          (r) =>
            r.ownerUid === record.ownerUid &&
            r.cacheKey === record.cacheKey &&
            r.kind === record.kind,
        );
      if (existing) {
        if (
          existing.vocals.sha256 !== record.vocals.sha256 ||
          existing.personalJobId !== record.personalJobId ||
          existing.videoId !== record.videoId ||
          JSON.stringify(artifactDeclaration(existing.vocals)) !==
            JSON.stringify(artifactDeclaration(record.vocals)) ||
          JSON.stringify(
            existing.original ? artifactDeclaration(existing.original) : null,
          ) !==
            JSON.stringify(
              record.original ? artifactDeclaration(record.original) : null,
            )
        )
          throw new Error("OUTBOX_IDENTITY_CONFLICT");
        return existing;
      }
      if (all.length >= OUTBOX_MAX_RECORDS)
        throw new Error("OUTBOX_RECORD_LIMIT");
      const retained = all.filter((r) => !r.copiesReleased);
      if (
        retained.reduce((sum, r) => sum + (r.original?.bytes ?? 0), 0) +
          (record.original?.bytes ?? 0) >
          OUTBOX_ORIGINAL_BUDGET ||
        retained.reduce((sum, r) => sum + r.vocals.bytes, 0) +
          record.vocals.bytes >
          OUTBOX_VOCALS_BUDGET
      )
        throw new Error("OUTBOX_RETENTION_LIMIT");
      await this.files.write(checked);
      return checked;
    });
  }
  async update(
    expected: OutboxRecord,
    patch: Partial<OutboxRecord>,
  ): Promise<OutboxRecord> {
    return this.files.locked(async () => {
      const current = (await this.list(expected.ownerUid)).find(
        (r) => r.requestId === expected.requestId,
      );
      if (
        !current ||
        current.revision !== expected.revision ||
        current.attemptId !== expected.attemptId
      )
        throw new Error("OUTBOX_ATTEMPT_CHANGED");
      const next = parseOutboxRecord(
        { ...current, ...patch, revision: current.revision + 1 },
        this.installationId,
      );
      if (
        next.ownerUid !== current.ownerUid ||
        next.requestId !== current.requestId ||
        next.cacheKey !== current.cacheKey ||
        JSON.stringify(next.original) !== JSON.stringify(current.original) ||
        JSON.stringify(next.vocals) !== JSON.stringify(current.vocals) ||
        next.installationId !== current.installationId ||
        next.ownerGeneration !== current.ownerGeneration ||
        next.personalJobId !== current.personalJobId ||
        next.kind !== current.kind ||
        next.videoId !== current.videoId ||
        next.title !== current.title ||
        next.createdAt !== current.createdAt ||
        next.modelDigest !== current.modelDigest ||
        next.recipeDigest !== current.recipeDigest
      )
        throw new Error("OUTBOX_IDENTITY_CONFLICT");
      await this.files.write(next);
      return next;
    });
  }
}
export class WindowsOutboxStore extends JournalOutboxStore {
  constructor(host: HostContext) {
    super(
      {
        list: async () => {
          await host.directory("outbox");
          const records: unknown[] = [];
          let directories = 0;
          const owners = await readdir(win32.join(host.personalRoot, "outbox"));
          if (owners.length > 32) throw new Error("OUTBOX_RECORD_LIMIT");
          for (const owner of owners) {
            if (!/^[a-f0-9]{64}$/.test(owner))
              throw new Error("OUTBOX_RECORD_INVALID");
            await host.native.validatePath(
              "personal",
              `outbox\\${owner}`,
              "directory",
            );
            const ids = await readdir(
              win32.join(host.personalRoot, "outbox", owner),
            );
            for (const id of ids) {
              if (!OUTBOX_UUID.test(id))
                throw new Error("OUTBOX_RECORD_INVALID");
              if (++directories > OUTBOX_MAX_RECORDS)
                throw new Error("OUTBOX_RECORD_LIMIT");
              const relative = `outbox\\${owner}\\${id}\\record.json`;
              await host.native.validatePath(
                "personal",
                `outbox\\${owner}\\${id}`,
                "directory",
              );
              try {
                await lstat(win32.join(host.personalRoot, relative));
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                  throw error;
                // A crash before atomic publication can leave an empty metadata
                // directory. Media without its journal remains a visible fault.
                const files = await readdir(
                  win32.join(host.personalRoot, "outbox", owner, id),
                );
                if (
                  files.some(
                    (name) => !/^record\.json\.[a-f0-9-]{36}\.tmp$/.test(name),
                  )
                )
                  throw new Error("OUTBOX_RECOVERY_REQUIRED");
                for (const name of files) {
                  const pending = `outbox\\${owner}\\${id}\\${name}`;
                  await host.native.validatePath("personal", pending, "file");
                  const stat = await lstat(
                    win32.join(host.personalRoot, pending),
                  );
                  if (
                    !stat.isFile() ||
                    stat.isSymbolicLink() ||
                    stat.nlink !== 1 ||
                    stat.size > OUTBOX_MAX_RECORD_BYTES
                  )
                    throw new Error("OUTBOX_RECOVERY_REQUIRED");
                }
                continue;
              }
              const record = JSON.parse(
                (
                  await readPrivateBytes(
                    host,
                    relative,
                    OUTBOX_MAX_RECORD_BYTES,
                  )
                ).toString("utf8"),
              ) as OutboxRecord;
              if (
                outboxOwner(record.ownerUid) !== owner ||
                record.requestId !== id
              )
                throw new Error("OUTBOX_RECORD_INVALID");
              records.push(record);
            }
          }
          return records;
        },
        write: async (record) => {
          const root = outboxRoot(record);
          await host.directory(root);
          await writePrivateAtomic(
            host,
            `${root}\\record.json`,
            Buffer.from(JSON.stringify(record)),
          );
        },
        locked: async (action) => {
          const deadline = performance.now() + 2000;
          while (true) {
            const lease = await host.native.acquireMutex("cache");
            if (lease) {
              try {
                return await action();
              } finally {
                await host.native.releaseMutex(lease);
              }
            }
            // Retry only before entering a mutation. An uncertain write is
            // reconciled from its durable journal instead of being replayed.
            if (performance.now() >= deadline) throw new Error("OUTBOX_BUSY");
            await delay(25);
          }
        },
      },
      host.report.installationId,
    );
  }
}
