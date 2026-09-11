import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  trusted,
  Types,
  type ClientSession,
  type Connection,
  type Model,
} from 'mongoose';
import { operationFingerprint } from '../admin/admin-audit-query.js';
import { adminError } from '../admin/admin-errors.js';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import type { AdminActor } from '../admin/admin.types.js';
import type { AcknowledgeAdminAlertDto } from './dto/admin-alert.dto.js';
import { AdminAlertObservation } from './admin-alert-observation.schema.js';
import {
  AdminAlert,
  ALERT_TYPES,
  type AlertSeverity,
  type AlertType,
} from './admin-alert.schema.js';

export interface AlertCondition {
  type: AlertType;
  severity: AlertSeverity;
  resourceId: string | null;
  message: string;
}

function present(alert: AdminAlert & { _id: Types.ObjectId }) {
  return {
    id: alert._id.toString(),
    type: alert.type,
    severity: alert.severity,
    resourceId: alert.resourceId ?? null,
    state: alert.state,
    firstSeenAt: alert.firstSeenAt.toISOString(),
    lastSeenAt: alert.lastSeenAt.toISOString(),
    resolvedAt: alert.resolvedAt?.toISOString() ?? null,
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: alert.acknowledgedBy ?? null,
    revision: alert.revision,
    message: alert.message,
  };
}

@Injectable()
export class AdminAlertsService implements OnModuleInit {
  constructor(
    @InjectModel(AdminAlert.name) private readonly alerts: Model<AdminAlert>,
    @InjectModel(AdminAlertObservation.name)
    private readonly observations: Model<AdminAlertObservation>,
    @InjectConnection() private readonly database: Connection,
    private readonly operations: AdminOperationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await Promise.all([this.alerts.init(), this.observations.init()]);
    await Promise.all(
      ALERT_TYPES.map((type) =>
        this.observations
          .updateOne(
            { _id: type },
            { $setOnInsert: { observedAt: new Date(0) } },
            { upsert: true, runValidators: true },
          )
          .catch((error: unknown) => {
            if ((error as { code?: number }).code !== 11000) throw error;
          }),
      ),
    );
  }

  async list(raw: Record<string, unknown>) {
    if (
      Object.keys(raw).some(
        (key) => !['state', 'severity', 'limit', 'cursor'].includes(key),
      )
    )
      throw adminError('INVALID_REQUEST');
    const state = raw.state === undefined ? null : String(raw.state);
    const severity = raw.severity === undefined ? null : String(raw.severity);
    if (state !== null && !['active', 'resolved'].includes(state))
      throw adminError('INVALID_REQUEST');
    if (severity !== null && !['warning', 'critical'].includes(severity))
      throw adminError('INVALID_REQUEST');
    const selectedState = state as AdminAlert['state'] | null;
    const selectedSeverity = severity as AlertSeverity | null;
    const limit = raw.limit === undefined ? 25 : Number(raw.limit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (raw.limit !== undefined && !/^\d{1,3}$/.test(String(raw.limit)))
    )
      throw adminError('INVALID_REQUEST');
    const scope = operationFingerprint({
      state: selectedState,
      severity: selectedSeverity,
    });
    const after = this.decodeCursor(raw.cursor, scope);
    const rows = await this.alerts
      .find({
        ...(selectedState ? { state: selectedState } : {}),
        ...(selectedSeverity ? { severity: selectedSeverity } : {}),
        ...(after ? { _id: trusted({ $lt: after }) } : {}),
      })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .maxTimeMS(5000)
      .lean();
    const items = rows.slice(0, limit) as (AdminAlert & {
      _id: Types.ObjectId;
    })[];
    return {
      items: items.map(present),
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({ id: items.at(-1)!._id.toString(), scope }),
            ).toString('base64url')
          : null,
      asOf: new Date().toISOString(),
    };
  }

  async countActive(): Promise<number> {
    return this.alerts.countDocuments({ state: 'active' }).maxTimeMS(5000);
  }

  async acknowledge(
    actor: AdminActor,
    id: string,
    dto: AcknowledgeAdminAlertDto,
  ) {
    const objectId = this.objectId(id);
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'POST /admin/alerts/:id/acknowledge',
        request: { id, expectedRevision: dto.expectedRevision },
        action: 'alerts.acknowledge',
        resourceType: 'alert',
        reason: dto.reason,
      },
      async (session) => {
        const current = await this.alerts
          .findOne({ _id: objectId })
          .session(session)
          .lean();
        if (!current) throw adminError('RESOURCE_NOT_FOUND');
        if (current.revision !== dto.expectedRevision)
          throw adminError('REVISION_CONFLICT');
        if (current.state !== 'active' || current.acknowledgedAt)
          throw adminError('INVALID_REQUEST');
        const updated = await this.alerts
          .findOneAndUpdate(
            {
              _id: objectId,
              state: 'active',
              acknowledgedAt: null,
              revision: dto.expectedRevision,
            },
            {
              $set: {
                acknowledgedAt: new Date(),
                acknowledgedBy: actor.uid,
              },
              $inc: { revision: 1 },
            },
            { returnDocument: 'after', runValidators: true, session },
          )
          .lean();
        if (!updated) throw adminError('REVISION_CONFLICT');
        return {
          resourceId: id,
          previousRevision: dto.expectedRevision,
          revision: dto.expectedRevision + 1,
          value: present(updated as never),
        };
      },
    );
    return result.value ?? this.detail(result.receipt.resourceId!);
  }

  async reconcile(
    conditions: readonly AlertCondition[],
    observedTypes: readonly AlertType[],
    at = new Date(),
  ): Promise<void> {
    await this.database.transaction(async (session) => {
      const claimedTypes: AlertType[] = [];
      for (const type of observedTypes) {
        const marker = await this.observations
          .findById(type)
          .session(session)
          .lean();
        if (!marker || marker.observedAt >= at) continue;
        const claimed = await this.observations.updateOne(
          { _id: type, observedAt: marker.observedAt },
          { $set: { observedAt: at } },
          { session, runValidators: true },
        );
        if (claimed.modifiedCount === 1) claimedTypes.push(type);
      }
      if (!claimedTypes.length) return;
      await this.reconcileClaimed(
        conditions.filter((condition) => claimedTypes.includes(condition.type)),
        claimedTypes,
        at,
        session,
      );
    });
  }

  private async reconcileClaimed(
    conditions: readonly AlertCondition[],
    observedTypes: readonly AlertType[],
    at: Date,
    session: ClientSession,
  ): Promise<void> {
    const active = await this.alerts
      .find({
        state: 'active',
        type: trusted({ $in: [...observedTypes] }),
      })
      .session(session)
      .maxTimeMS(5000)
      .lean();
    const keys = new Set(
      conditions.map((condition) => this.conditionKey(condition)),
    );
    const bucket = new Date(Math.floor(at.getTime() / 30_000) * 30_000);
    for (const condition of [...conditions].sort((a, b) =>
      this.conditionKey(a).localeCompare(this.conditionKey(b)),
    )) {
      const existing = active.find(
        (alert) => this.conditionKey(alert) === this.conditionKey(condition),
      );
      if (existing) {
        if (
          existing.severity === condition.severity &&
          existing.message === condition.message &&
          existing.lastSeenAt >= bucket
        )
          continue;
        await this.alerts.updateOne(
          { _id: existing._id, state: 'active', revision: existing.revision },
          {
            $set: {
              severity: condition.severity,
              message: condition.message,
              lastSeenAt: at,
            },
            $inc: { revision: 1 },
          },
          { runValidators: true, session },
        );
        continue;
      }
      try {
        await this.alerts.create(
          [
            {
              ...condition,
              state: 'active',
              firstSeenAt: at,
              lastSeenAt: at,
              resolvedAt: null,
              acknowledgedAt: null,
              acknowledgedBy: null,
              revision: 0,
            },
          ],
          { session },
        );
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        const concurrent = await this.alerts
          .findOne({
            type: condition.type,
            resourceId: condition.resourceId,
            state: 'active',
          })
          .session(session)
          .maxTimeMS(5000)
          .lean();
        if (
          !concurrent ||
          (concurrent.severity === condition.severity &&
            concurrent.message === condition.message &&
            concurrent.lastSeenAt >= bucket)
        )
          continue;
        await this.alerts.updateOne(
          {
            _id: concurrent._id,
            state: 'active',
            revision: concurrent.revision,
          },
          {
            $set: {
              severity: condition.severity,
              message: condition.message,
              lastSeenAt: at,
            },
            $inc: { revision: 1 },
          },
          { runValidators: true, session },
        );
      }
    }
    for (const alert of active) {
      if (keys.has(this.conditionKey(alert))) continue;
      await this.alerts.updateOne(
        { _id: alert._id, state: 'active', revision: alert.revision },
        {
          $set: { state: 'resolved', resolvedAt: at, lastSeenAt: at },
          $inc: { revision: 1 },
        },
        { runValidators: true, session },
      );
    }
  }

  private async detail(id: string) {
    const alert = await this.alerts
      .findOne({ _id: this.objectId(id) })
      .maxTimeMS(5000)
      .lean();
    if (!alert) throw adminError('RESOURCE_NOT_FOUND');
    return present(alert as never);
  }

  private conditionKey(value: Pick<AlertCondition, 'type' | 'resourceId'>) {
    return `${value.type}\0${value.resourceId ?? ''}`;
  }

  private objectId(value: string) {
    if (!/^[a-f0-9]{24}$/.test(value) || !Types.ObjectId.isValid(value))
      throw adminError('RESOURCE_NOT_FOUND');
    return new Types.ObjectId(value);
  }

  private decodeCursor(raw: unknown, scope: string) {
    if (raw === undefined) return undefined;
    try {
      if (
        typeof raw !== 'string' ||
        raw.length > 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(raw)
      )
        throw new Error();
      const text = Buffer.from(raw, 'base64url').toString('utf8');
      if (Buffer.from(text).toString('base64url') !== raw) throw new Error();
      const decoded = JSON.parse(text) as Record<string, unknown>;
      if (
        !decoded ||
        Array.isArray(decoded) ||
        Object.keys(decoded).sort().join(',') !== 'id,scope' ||
        decoded.scope !== scope ||
        typeof decoded.id !== 'string' ||
        !/^[a-f0-9]{24}$/.test(decoded.id)
      )
        throw new Error();
      return new Types.ObjectId(decoded.id);
    } catch {
      throw adminError('INVALID_CURSOR');
    }
  }
}
