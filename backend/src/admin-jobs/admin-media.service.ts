import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { adminError } from '../admin/admin-errors.js';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import type { AdminActor } from '../admin/admin.types.js';
import { Job } from '../jobs/job.schema.js';
import { AccountAccessService } from '../users/account-access.service.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import type { AdminMediaGrantDto } from './dto/admin-media-grant.dto.js';

@Injectable()
export class AdminMediaService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly accounts: AccountAccessService,
    private readonly storage: StorageTransfersService,
    private readonly operations: AdminOperationsService,
  ) {}

  async grant(actor: AdminActor, id: string, dto: AdminMediaGrantDto) {
    if (
      !actor.permissions.includes('jobs.read') ||
      !actor.permissions.includes('media.read')
    )
      throw adminError('PERMISSION_DENIED');
    if (!/^[a-f0-9]{24}$/.test(id)) throw adminError('RESOURCE_NOT_FOUND');
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'POST /admin/jobs/:id/media-grants',
        request: { id, asset: dto.asset, purpose: dto.purpose },
        action: `media.${dto.asset}.${dto.purpose}.grant`,
        resourceType: 'job',
        reason: dto.reason,
      },
      async (session) => {
        const job = await this.jobs
          .findOne({ _id: new Types.ObjectId(id), deletedAt: null })
          .session(session)
          .lean();
        if (!job || job.deletedAt) throw adminError('RESOURCE_NOT_FOUND');
        const object =
          dto.asset === 'input'
            ? job.inputObject
            : job.status === 'ready'
              ? job.outputObject
              : null;
        if (!object || !object.versionId || object.versionId === 'null')
          throw adminError('MEDIA_UNAVAILABLE');
        await this.accounts.assertActive(job.userId, session);
        // Conflict with deletion/rename or worker writes before exposing the URL.
        const touched = await this.jobs.updateOne(
          { _id: job._id, deletedAt: null, revision: job.revision },
          { $inc: { revision: 1 } },
          { session },
        );
        if (touched.modifiedCount !== 1) throw adminError('REVISION_CONFLICT');
        if (!(await this.storage.isPinnedObjectAvailable(object)))
          throw adminError('MEDIA_UNAVAILABLE');
        const extension =
          dto.asset === 'result' ? 'mp3' : job.inputReservation.extension;
        if (!/^[a-z0-9]{1,8}$/.test(extension))
          throw adminError('MEDIA_UNAVAILABLE');
        const filename = `${dto.asset === 'result' ? 'vocals' : 'input'}-${id}.${extension}`;
        const grant = await this.storage.createMediaGrant(
          object,
          dto.purpose,
          filename,
        );
        return {
          resourceId: id,
          value: {
            ...grant,
            bytes: object.bytes,
            contentType: object.contentType,
            filename,
          },
        };
      },
    );
    // URLs are intentionally absent from receipts. A fresh, explicit operation
    // is required after an uncertain/lost response; replay never issues a URL.
    if (!result.value) throw adminError('REVISION_CONFLICT');
    return result.value;
  }
}
