import { WorkerReadinessService } from './worker-readiness.service.js';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  HttpException,
  ValidationPipe,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { WorkerRegistration } from './worker-registration.schema.js';
import { WorkerRegistryService } from './worker-registry.service.js';
import { WorkerRuntime } from './worker-runtime.schema.js';
import {
  InstallationReadyDto,
  WorkerRuntimeDto,
} from './dto/worker-runtime.dto.js';
import type { WorkerIdentity } from './worker-routes.js';

const validation = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

@Injectable()
export class WorkerRuntimeService {
  constructor(
    @InjectModel(WorkerRuntime.name)
    private readonly runtimes: Model<WorkerRuntime>,
    @InjectModel(WorkerRegistration.name)
    private readonly registrations: Model<WorkerRegistration>,
    private readonly registry: WorkerRegistryService,
    private readonly transactions: ProcessingTransactions,
  ) {}

  async validate(report: WorkerRuntimeDto): Promise<WorkerRuntimeDto> {
    const valid = (await validation.transform(report, {
      type: 'body',
      metatype: WorkerRuntimeDto,
    })) as WorkerRuntimeDto;
    if (valid.protocolVersion !== 3)
      throw new HttpException(
        {
          code: 'WORKER_REINSTALL_REQUIRED',
          message:
            'Install the current worker release; worker protocol version 3 is required.',
          requiredProtocolVersion: 3,
        },
        426,
      );
    return valid;
  }

  private async binding(
    identity: WorkerIdentity,
    installationId: string,
    session: ClientSession,
  ) {
    const row = await this.registrations
      .findOne({
        _id: identity.workerId,
        keySha256: identity.keySha256,
        installationId,
      })
      .session(session)
      .lean();
    if (!row)
      throw new ForbiddenException({
        code: 'INSTALLATION_BINDING_MISMATCH',
        message:
          'This installation is not paired with the authenticated worker.',
      });
  }

  async store(identity: WorkerIdentity, report: WorkerRuntimeDto) {
    const valid = await this.validate(report);
    return this.transactions.run(async (session) => {
      await this.registry.state(identity, session);
      await this.binding(identity, valid.installationId, session);
      await this.runtimes.updateOne(
        { _id: identity.workerId },
        { $set: { report: valid, receivedAt: new Date() } },
        { upsert: true, runValidators: true, session },
      );
      return { accepted: true };
    });
  }

  readRuntime(workerId: string) {
    return this.runtimes.findById(workerId).lean();
  }

  async installationReady(
    identity: WorkerIdentity,
    input: InstallationReadyDto,
  ) {
    const dto = (await validation.transform(input, {
      type: 'body',
      metatype: InstallationReadyDto,
    })) as InstallationReadyDto;
    const report = await this.validate(dto.runtime);
    if (
      dto.installationId !== report.installationId ||
      dto.bootReport.profileId !== report.profileId
    )
      throw new BadRequestException({
        code: 'READINESS_REPORT_MISMATCH',
        message: 'Installation and profile must match the runtime report.',
      });
    return this.transactions.run(async (session) => {
      await this.binding(identity, dto.installationId, session);
      await this.registry.fence(identity, session);
      const now = new Date();
      await this.runtimes.updateOne(
        { _id: identity.workerId },
        {
          $set: {
            report,
            receivedAt: now,
            reportedBoot: dto.bootReport,
            qualificationReportId: dto.qualificationReportId,
            readinessReceivedAt: now,
          },
        },
        { upsert: true, runValidators: true, session },
      );
      const readiness = await new WorkerReadinessService(
        this.runtimes.db,
      ).evaluateNewClaim(identity.workerId, session);
      // Signed authority and the installation report are evaluated together.
      return {
        accepted: true,
        canClaim: readiness.allowed,
        reasonCodes: readiness.reasonCodes,
      };
    });
  }
}
