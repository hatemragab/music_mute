import { HttpException, Injectable, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  trusted,
  type ClientSession,
  type Connection,
  type Model,
} from 'mongoose';
import { AdminAccess } from './admin-access.schema.js';
import { AdminOperation } from './admin-operation.schema.js';
import { AdminAuditService } from './admin-audit.service.js';
import {
  operationFingerprint,
  validOperationId,
  validateAuditEvent,
  type StopEvidenceMetadata,
  type AuditExportMetadata,
} from './admin-audit-query.js';
import { adminError } from './admin-errors.js';
import type { AdminActor } from './admin.types.js';

export interface AdminCommand {
  operationId: string;
  route: string;
  request: Record<string, unknown>;
  action: string;
  resourceType: string;
  reason: string | null;
}

export interface AdminMutationResult<T> {
  exportMetadata?: AuditExportMetadata | null;
  stopEvidence?: StopEvidenceMetadata | null;
  resourceId: string;
  revision?: number | null;
  previousRevision?: number | null;
  /** Returned only to this invocation; never stored in an operation receipt. */
  value: T;
}

export interface AdminOperationReceipt {
  operationId: string;
  status: 'pending' | 'succeeded' | 'failed';
  resourceId: string | null;
  revision: number | null;
  code?: string;
}

@Injectable()
export class AdminOperationsService implements OnModuleInit {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(AdminAccess.name) private readonly access: Model<AdminAccess>,
    @InjectModel(AdminOperation.name)
    private readonly operations: Model<AdminOperation>,
    private readonly audit: AdminAuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.operations.init();
  }

  async run<T>(
    actor: AdminActor,
    command: AdminCommand,
    mutate: (session: ClientSession) => Promise<AdminMutationResult<T>>,
  ): Promise<{
    receipt: AdminOperationReceipt;
    value: T | undefined;
    replayed: boolean;
  }> {
    if (
      !validOperationId(command.operationId) ||
      !/^(POST|PUT|PATCH|DELETE|GET) \/admin\/[a-zA-Z0-9/_:.-]{1,180}$/.test(
        command.route,
      )
    )
      throw adminError('INVALID_REQUEST');
    const requestHash = operationFingerprint({
      route: command.route,
      request: command.request,
      action: command.action,
      reason: command.reason,
      resourceType: command.resourceType,
    });
    // Validate metadata before any domain side effect; the real resource ID is checked again below.
    validateAuditEvent({
      actorUid: actor.uid,
      action: command.action,
      resourceType: command.resourceType,
      resourceId: 'pending',
      operationId: command.operationId,
      reason: command.reason,
      previousRevision: null,
      nextRevision: null,
      outcome: 'succeeded',
    });
    const key = { actorUid: actor.uid, operationId: command.operationId };
    const existing = await this.lookup(key);
    const replay = (receipt: AdminOperation) => {
      if (
        receipt.requestHash !== requestHash ||
        receipt.route !== command.route
      )
        throw adminError('REVISION_CONFLICT');
      if (receipt.status === 'pending')
        throw adminError('OPERATION_IN_PROGRESS');
      if (receipt.status === 'failed') throw adminError('REVISION_CONFLICT');
      return {
        receipt: this.present(receipt),
        value: undefined,
        replayed: true,
      };
    };
    if (existing) return replay(existing);
    const executionToken = randomUUID();
    try {
      await this.operations.create({
        ...key,
        route: command.route,
        requestHash,
        status: 'pending',
        executionToken,
        pendingUntil: new Date(Date.now() + 30000),
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const concurrent = await this.lookup(key);
      if (!concurrent) throw adminError('DEPENDENCY_UNAVAILABLE');
      return replay(concurrent);
    }
    const owned = { ...key, status: 'pending' as const, executionToken };
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(
        async () => {
          // This write fences timeout recovery against a transaction that could still commit.
          const reservation = await this.operations.updateOne(
            { ...owned, pendingUntil: trusted({ $gt: new Date() }) },
            { $inc: { executionFence: 1 } },
            { session },
          );
          if (reservation.matchedCount !== 1)
            throw adminError('REVISION_CONFLICT');
          // Writes conflict with role changes/revocation; a guard-only check leaves a race.
          const authority = await this.access.updateOne(
            { uid: actor.uid, active: true, revision: actor.accessRevision },
            { $inc: { authorizationFence: 1 } },
            { session, timestamps: false },
          );
          if (authority.modifiedCount !== 1)
            throw adminError('PERMISSION_DENIED');
          const result = await mutate(session);
          await this.audit.record(
            {
              actorUid: actor.uid,
              action: command.action,
              resourceType: command.resourceType,
              resourceId: result.resourceId,
              operationId: command.operationId,
              reason: command.reason,
              previousRevision: result.previousRevision ?? null,
              nextRevision: result.revision ?? null,
              outcome: 'succeeded',
              ...(result.stopEvidence
                ? { stopEvidence: result.stopEvidence }
                : {}),
              ...(result.exportMetadata
                ? { exportMetadata: result.exportMetadata }
                : {}),
            },
            session,
          );
          const receipt = {
            actorUid: actor.uid,
            route: command.route,
            operationId: command.operationId,
            requestHash,
            status: 'succeeded' as const,
            resourceId: result.resourceId,
            revision: result.revision ?? null,
            at: new Date(),
          };
          const completion = await this.operations.updateOne(
            owned,
            {
              $set: {
                ...receipt,
                code: null,
                executionToken: null,
                pendingUntil: null,
              },
            },
            { session },
          );
          if (completion.modifiedCount !== 1)
            throw adminError('REVISION_CONFLICT');
          return {
            receipt: this.present(receipt),
            value: result.value,
            replayed: false,
          };
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
          maxCommitTimeMS: 5000,
          timeoutMS: 10000,
        },
      );
    } catch (error) {
      const response =
        error instanceof HttpException ? error.getResponse() : null;
      const code =
        response &&
        typeof response === 'object' &&
        'code' in response &&
        typeof response.code === 'string'
          ? response.code
          : 'DEPENDENCY_UNAVAILABLE';
      await this.operations.updateOne(owned, {
        $set: {
          status: 'failed',
          code,
          executionToken: null,
          pendingUntil: null,
        },
      });
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async read(
    actor: AdminActor,
    operationId: string,
    actorUid = actor.uid,
  ): Promise<AdminOperationReceipt> {
    if (!validOperationId(operationId) || !actorUid || actorUid.length > 128)
      throw adminError('INVALID_REQUEST');
    if (actorUid !== actor.uid && actor.role !== 'owner')
      throw adminError('RESOURCE_NOT_FOUND');
    const result = await this.lookup({ actorUid, operationId });
    if (!result) throw adminError('RESOURCE_NOT_FOUND');
    return this.present(result);
  }

  private async lookup(key: {
    actorUid: string;
    operationId: string;
  }): Promise<AdminOperation | null> {
    const result = await this.operations.findOne(key).maxTimeMS(5000).lean();
    if (
      result?.status === 'pending' &&
      result.pendingUntil &&
      result.pendingUntil.getTime() <= Date.now()
    ) {
      await this.operations.updateOne(
        {
          ...key,
          status: 'pending',
          pendingUntil: trusted({ $lte: new Date() }),
        },
        {
          $set: {
            status: 'failed',
            code: 'DEPENDENCY_UNAVAILABLE',
            executionToken: null,
            pendingUntil: null,
          },
        },
      );
      return this.operations.findOne(key).maxTimeMS(5000).lean();
    }
    return result;
  }

  private present(
    result: Pick<
      AdminOperation,
      'operationId' | 'status' | 'resourceId' | 'revision'
    >,
  ): AdminOperationReceipt {
    return {
      operationId: result.operationId,
      status: result.status,
      resourceId: result.resourceId,
      revision: result.revision,
      ...(result.status === 'failed'
        ? { code: (result as AdminOperation).code ?? 'DEPENDENCY_UNAVAILABLE' }
        : {}),
    };
  }
}
