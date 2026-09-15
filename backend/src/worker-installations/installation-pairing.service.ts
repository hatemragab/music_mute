import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { trusted } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import { adminError } from '../admin/admin-errors.js';
import type { AdminActor } from '../admin/admin.types.js';
import { WorkerQualificationService } from '../worker/worker-qualification.service.js';
import { WorkerInstallation } from './worker-installation.schema.js';
import {
  codeLookup,
  equalDigest,
  pairingCode,
  tokenDigest,
} from './installation-secrets.js';
import type {
  ApproveInstallationDto,
  InstallationQualificationDto,
  RegisterInstallationDto,
  RejectInstallationDto,
  RequestPairingDto,
} from './installation.dto.js';
import { INSTALLATION_ID_PATTERN } from '../worker/dto/worker-runtime.dto.js';
import { WorkerRegistryService } from '../worker/worker-registry.service.js';
import type { WorkerIdentity } from '../worker/worker-routes.js';
import type { WorkerRegistration } from '../worker/worker-registration.schema.js';
import { reserveCredential } from './credential-reservation.schema.js';

const DAY = 86_400_000;
const privateFields = '+tokenSha256 +workerKeySha256 +codeLookup +codeNonce';
export function presentInstallation(row: WorkerInstallation) {
  const expired = row.codeExpiresAt && +row.codeExpiresAt <= Date.now();
  return {
    installationId: row._id,
    installerBuild: row.installerBuild,
    os: row.os,
    arch: row.arch,
    revision: row.revision,
    setupState: row.assignedWorkerId ? 'pending_boot_verification' : 'reported',
    pairingState:
      row.pairingState === 'pending' && expired ? 'expired' : row.pairingState,
    assignedWorkerId: row.assignedWorkerId,
    tokenExpiresAt: row.tokenExpiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class InstallationPairingService {
  private readonly secret: string;
  constructor(
    @InjectConnection() private readonly db: Connection,
    @InjectModel(WorkerInstallation.name)
    private readonly installations: Model<WorkerInstallation>,
    private readonly qualification: WorkerQualificationService,
    private readonly operations: AdminOperationsService,
    private readonly config: ConfigService,
    private readonly registry: WorkerRegistryService,
  ) {
    this.secret = config.getOrThrow<string>('RATE_LIMIT_HASH_SECRET');
  }

  async register(dto: RegisterInstallationDto) {
    return this.transaction(async (session) => {
      const now = new Date();
      if (
        await this.db
          .model('WorkerRegistration')
          .exists({ keySha256: dto.tokenSha256 })
          .session(session)
      )
        throw new ConflictException('Credential binding conflict');
      await reserveCredential(
        this.db,
        session,
        dto.tokenSha256,
        'installation',
        dto.installationId,
      );
      await this.installations.updateOne(
        { _id: dto.installationId },
        {
          $setOnInsert: {
            _id: dto.installationId,
            tokenSha256: dto.tokenSha256,
            installerBuild: dto.installerBuild,
            os: dto.os,
            arch: dto.arch,
            createdAt: now,
            tokenExpiresAt: new Date(+now + DAY),
          },
        },
        { upsert: true, session },
      );
      const row = await this.installations
        .findById(dto.installationId)
        .select(privateFields)
        .session(session)
        .lean();
      if (
        !row ||
        row.revoked ||
        +row.tokenExpiresAt <= Date.now() ||
        !equalDigest(row.tokenSha256, dto.tokenSha256) ||
        row.installerBuild !== dto.installerBuild ||
        row.os !== dto.os ||
        row.arch !== dto.arch
      )
        throw new ConflictException('Installation registration conflict');
      return {
        installationId: row._id,
        tokenExpiresAt: row.tokenExpiresAt.toISOString(),
        serverTime: now.toISOString(),
        eventLimits: { maxBatchEvents: 50, maxBatchBytes: 65536 },
      };
    });
  }

  /** Shared authentication boundary for B03: digest only, exact path ownership, active bounded session. */
  async authenticate(
    id: string,
    authorization: string | undefined,
    session?: ClientSession,
  ) {
    if (
      !INSTALLATION_ID_PATTERN.test(id) ||
      !authorization ||
      !/^Bearer [a-f0-9]{64}$/.test(authorization)
    )
      throw new UnauthorizedException();
    const digest = tokenDigest(authorization.slice(7));
    const row = await this.installations
      .findOne({
        _id: id,
        tokenSha256: digest,
        revoked: false,
        tokenExpiresAt: trusted({ $gt: new Date() }),
      })
      .select(privateFields)
      .session(session ?? null);
    if (!row) throw new UnauthorizedException();
    return row;
  }
  async status(id: string, authorization: string | undefined) {
    const installation = presentInstallation(
      await this.authenticate(id, authorization),
    );
    return { ...installation, serverTime: new Date().toISOString() };
  }
  private async transaction<T>(fn: (session: ClientSession) => Promise<T>) {
    const session = await this.db.startSession();
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await session.withTransaction(() => fn(session), {
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
            readPreference: 'primary',
            timeoutMS: 10000,
          });
        } catch (error) {
          if ((error as { code?: number }).code !== 11000) throw error;
          if (attempt >= 2)
            throw new ConflictException('Concurrent binding conflict');
        }
      }
    } finally {
      await session.endSession();
    }
  }
  async renew(
    id: string,
    authorization: string | undefined,
    operationId: string,
  ) {
    return this.transaction(async (session) => {
      const row = await this.authenticate(id, authorization, session);
      if (row.pairingState === 'rejected') throw new ConflictException();
      const receipt = await this.db
        .collection('worker_installation_operations')
        .findOne({ installationId: id, operationId }, { session });
      if (receipt) {
        if (receipt.kind !== 'renew') throw new ConflictException();
        return { tokenExpiresAt: receipt.tokenExpiresAt as string };
      }
      const expires = new Date(
        Math.min(Date.now() + DAY, +row.createdAt + 7 * DAY),
      );
      row.tokenExpiresAt = expires;
      row.authorizationFence++;
      await row.save({ session });
      await this.db.collection('worker_installation_operations').insertOne(
        {
          installationId: id,
          operationId,
          kind: 'renew',
          tokenExpiresAt: expires.toISOString(),
        },
        { session },
      );
      return { tokenExpiresAt: expires.toISOString() };
    });
  }
  async report(
    id: string,
    authorization: string | undefined,
    dto: InstallationQualificationDto,
  ) {
    return this.transaction(async (session) => {
      const row = await this.authenticate(id, authorization, session);
      if (dto.runtime.os !== row.os || dto.runtime.arch !== row.arch)
        throw new BadRequestException();
      row.authorizationFence++;
      await row.save({ session });
      return this.qualification.store(
        id,
        dto.runtime,
        dto.qualificationReport,
        dto.serviceBindingSha256,
        session,
      );
    });
  }
  async permanentReport(
    identity: WorkerIdentity,
    dto: InstallationQualificationDto,
  ) {
    return this.transaction(async (session) => {
      await this.registry.fence(identity, session);
      const registration = await this.db
        .model<WorkerRegistration>('WorkerRegistration')
        .findById(identity.workerId)
        .session(session)
        .lean();
      if (!registration?.installationId) throw new UnauthorizedException();
      return this.qualification.store(
        String(registration.installationId),
        dto.runtime,
        dto.qualificationReport,
        dto.serviceBindingSha256,
        session,
      );
    });
  }
  async issue(
    id: string,
    authorization: string | undefined,
    dto: RequestPairingDto,
  ) {
    return this.transaction(async (session) => {
      const row = await this.authenticate(id, authorization, session);
      if (
        row.assignedWorkerId ||
        row.pairingState === 'rejected' ||
        equalDigest(row.tokenSha256, dto.workerKeySha256) ||
        (row.workerKeySha256 &&
          !equalDigest(row.workerKeySha256, dto.workerKeySha256))
      )
        throw new ConflictException();
      const receipt = await this.db
        .collection('worker_installation_operations')
        .findOne(
          { installationId: id, operationId: dto.operationId },
          { session },
        );
      if (receipt) {
        if (
          receipt.kind !== 'pairing' ||
          row.pairingOperationId !== dto.operationId ||
          row.reportId !== dto.reportId ||
          !row.codeNonce ||
          !row.codeExpiresAt ||
          +row.codeExpiresAt <= Date.now()
        )
          throw new ConflictException();
        return {
          userCode: pairingCode(this.secret, id, row.codeNonce),
          expiresAt: row.codeExpiresAt.toISOString(),
        };
      }
      if (
        row.pairingState === 'pending' &&
        row.codeExpiresAt &&
        +row.codeExpiresAt > Date.now()
      )
        throw new ConflictException();
      const decision = await this.qualification.evaluateForPairing(
        id,
        dto.reportId,
        session,
      );
      if (!decision.allowed)
        throw new ConflictException('Qualification required');
      await reserveCredential(
        this.db,
        session,
        dto.workerKeySha256,
        'worker',
        id,
      );
      row.workerKeySha256 = dto.workerKeySha256;
      row.reportId = dto.reportId;
      row.codeNonce = randomBytes(32).toString('hex');
      const userCode = pairingCode(this.secret, id, row.codeNonce);
      row.codeLookup = codeLookup(this.secret, userCode);
      row.codeExpiresAt = new Date(Date.now() + 900000);
      row.pairingOperationId = dto.operationId;
      row.pairingState = 'pending';
      row.revision++;
      await row.save({ session });
      await this.db
        .collection('worker_installation_operations')
        .insertOne(
          { installationId: id, operationId: dto.operationId, kind: 'pairing' },
          { session },
        );
      return { userCode, expiresAt: row.codeExpiresAt.toISOString() };
    });
  }
  async list(raw: Record<string, unknown>) {
    if (
      Object.keys(raw).some(
        (key) => !['limit', 'cursor', 'pairingState'].includes(key),
      )
    )
      throw new BadRequestException();
    const limit = raw.limit === undefined ? 50 : Number(raw.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException();
    let after: string | undefined;
    if (raw.cursor !== undefined) {
      if (typeof raw.cursor !== 'string' || raw.cursor.length > 100)
        throw new BadRequestException();
      after = Buffer.from(raw.cursor, 'base64url').toString();
      if (!INSTALLATION_ID_PATTERN.test(after)) throw new BadRequestException();
    }
    if (
      raw.pairingState !== undefined &&
      !['unpaired', 'pending', 'approved', 'rejected'].includes(
        String(raw.pairingState),
      )
    )
      throw new BadRequestException();
    const rows = await this.installations
      .find({
        ...(after ? { _id: trusted({ $gt: after }) } : {}),
        ...(raw.pairingState ? { pairingState: raw.pairingState } : {}),
      })
      .sort({ _id: 1 })
      .limit(limit + 1)
      .maxTimeMS(5000)
      .lean();
    return {
      items: rows.slice(0, limit).map(presentInstallation),
      nextCursor:
        rows.length > limit
          ? Buffer.from(rows[limit - 1]!._id).toString('base64url')
          : null,
    };
  }
  async detail(id: string) {
    if (!INSTALLATION_ID_PATTERN.test(id))
      throw adminError('RESOURCE_NOT_FOUND');
    const row = await this.installations.findById(id).lean();
    if (!row) throw adminError('RESOURCE_NOT_FOUND');
    return presentInstallation(row);
  }
  async approve(actor: AdminActor, dto: ApproveInstallationDto) {
    if (!actor.permissions.includes('workers.manage'))
      throw adminError('PERMISSION_DENIED');
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      actor.authTimeSec > nowSec ||
      nowSec - actor.authTimeSec >
        this.config.get<number>('ADMIN_REAUTH_MAX_AGE_SECONDS', 300)
    )
      throw adminError('ADMIN_REAUTH_REQUIRED');
    const lookup = codeLookup(this.secret, dto.userCode);
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'POST /admin/worker-installations/approve',
        request: {
          codeBinding: lookup,
          expectedRevision: dto.expectedRevision,
          label: dto.label,
        },
        action: 'workers.pair',
        resourceType: 'worker',
        reason: null,
      },
      async (session) => {
        const row = await this.installations
          .findOne({
            codeLookup: lookup,
            pairingState: 'pending',
            revoked: false,
            tokenExpiresAt: trusted({ $gt: new Date() }),
            codeExpiresAt: trusted({ $gt: new Date() }),
            revision: dto.expectedRevision,
          })
          .select(privateFields)
          .session(session);
        if (!row || !row.reportId || !row.workerKeySha256)
          throw adminError('RESOURCE_NOT_FOUND');
        const qualified = await this.qualification.evaluateForPairing(
          row._id,
          row.reportId,
          session,
        );
        if (
          !qualified.allowed ||
          +row.tokenExpiresAt <= Date.now() ||
          !row.codeExpiresAt ||
          +row.codeExpiresAt <= Date.now()
        )
          throw adminError('RESOURCE_NOT_FOUND');
        const workerId = `worker-${randomUUID()}`;
        await this.db.model('WorkerRegistration').create(
          [
            {
              _id: workerId,
              installationId: row._id,
              label: dto.label,
              state: 'enabled',
              keySha256: row.workerKeySha256,
            },
          ],
          { session },
        );
        await this.db
          .model('WorkerControl')
          .create([{ _id: workerId, controlRevision: 0 }], { session });
        const previousRevision = row.revision;
        row.assignedWorkerId = workerId;
        row.pairingState = 'approved';
        row.codeNonce = null;
        row.codeLookup = null;
        row.revision++;
        await row.save({ session });
        return {
          resourceId: workerId,
          previousRevision,
          revision: row.revision,
          value: { workerId },
        };
      },
    );
    return { workerId: result.receipt.resourceId, receipt: result.receipt };
  }
  async reject(actor: AdminActor, id: string, dto: RejectInstallationDto) {
    if (!actor.permissions.includes('workers.manage'))
      throw adminError('PERMISSION_DENIED');
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'POST /admin/worker-installations/:id/reject',
        request: { id, expectedRevision: dto.expectedRevision },
        action: 'workers.pair-reject',
        resourceType: 'worker-installation',
        reason: dto.reason,
      },
      async (session) => {
        const row = await this.installations
          .findOne({
            _id: id,
            assignedWorkerId: null,
            pairingState: trusted({ $ne: 'rejected' }),
            revision: dto.expectedRevision,
          })
          .session(session);
        if (!row) throw adminError('REVISION_CONFLICT');
        row.pairingState = 'rejected';
        row.revoked = true;
        row.codeLookup = null;
        row.codeNonce = null;
        row.revision++;
        await row.save({ session });
        return {
          resourceId: id,
          previousRevision: dto.expectedRevision,
          revision: row.revision,
          value: null,
        };
      },
    );
    return { receipt: result.receipt };
  }
}
