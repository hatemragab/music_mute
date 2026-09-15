import { evaluateQualification } from './worker-readiness.service.js';
import type { WorkerRelease } from '../worker-releases/worker-release.schema.js';
import {
  BadRequestException,
  Injectable,
  ValidationPipe,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  QualificationReportDto,
  WorkerRuntimeDto,
  INSTALLATION_ID_PATTERN,
  SHA256_PATTERN,
} from './dto/worker-runtime.dto.js';
import type { WorkerQualification } from './worker-qualification.schema.js';
const validation = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});
@Injectable()
export class WorkerQualificationService {
  constructor(@InjectConnection() private readonly db: Connection) {}
  async evaluateForPairing(
    installationId: string,
    reportId: string,
    session?: ClientSession,
  ) {
    if (
      !INSTALLATION_ID_PATTERN.test(installationId) ||
      !INSTALLATION_ID_PATTERN.test(reportId)
    )
      throw new BadRequestException({ code: 'QUALIFICATION_REPORT_MISMATCH' });
    if (session)
      await this.db
        .model('ReleasePolicy')
        .updateOne(
          { _id: 'policy' },
          { $inc: { fence: 1 } },
          { session, upsert: true },
        );
    const qualification = await this.db
      .model<WorkerQualification>('WorkerQualification')
      .findOne({ _id: reportId, installationId })
      .session(session ?? null)
      .lean();
    const release = qualification
      ? await this.db
          .model<WorkerRelease>('WorkerRelease')
          .findOne({ buildNumber: qualification.runtime.workerBuild })
          .session(session ?? null)
          .lean()
      : null;
    return { reportId, ...evaluateQualification(qualification, release) };
  }
  /** B02 must authenticate the installation bearer and pass its own session ID here. No public route. */
  async store(
    installationId: string,
    runtime: WorkerRuntimeDto,
    report: QualificationReportDto,
    serviceBindingSha256: string,
    session?: ClientSession,
  ) {
    const validRuntime = (await validation.transform(runtime, {
      type: 'body',
      metatype: WorkerRuntimeDto,
    })) as WorkerRuntimeDto;
    const validReport = (await validation.transform(report, {
      type: 'body',
      metatype: QualificationReportDto,
    })) as QualificationReportDto;
    if (
      !INSTALLATION_ID_PATTERN.test(installationId) ||
      validRuntime.installationId !== installationId ||
      validRuntime.protocolVersion !== 3 ||
      !SHA256_PATTERN.test(serviceBindingSha256) ||
      validRuntime.profileId !== validReport.profileId ||
      validRuntime.modelSha256 !== validReport.modelSha256
    )
      throw new BadRequestException({ code: 'QUALIFICATION_REPORT_MISMATCH' });
    const reportId = randomUUID();
    await this.db.model<WorkerQualification>('WorkerQualification').create(
      [
        {
          _id: reportId,
          installationId,
          runtime: validRuntime,
          report: validReport,
          serviceBindingSha256,
          receivedAt: new Date(),
        },
      ],
      { session },
    );
    return {
      reportId,
      decision: 'reported' as const,
      reasonCodes: ['INSTALLATION_READINESS_REQUIRED'],
    };
  }
}
