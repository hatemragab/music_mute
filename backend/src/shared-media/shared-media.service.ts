import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { trusted, type ClientSession, type Model, type Types } from 'mongoose';
import { Job } from '../jobs/job.schema.js';
import {
  normalizeExtraData,
  type JobExtraData,
} from '../jobs/job-extra-data.js';
import type {
  InputDeclaration,
  InputReservation,
  ObjectIdentity,
} from '../jobs/job.types.js';
import {
  DEFAULT_WORKER_RECIPE_ID,
  workerRecipeSnapshot,
} from '../jobs/worker-recipes.js';
import { MediaImport } from '../url-imports/media-import.schema.js';
import { importError } from '../url-imports/import-errors.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import {
  SharedMediaSource,
  SharedMediaResult,
  SharedMediaArtifact,
} from './shared-media.schema.js';
import {
  sharedSourceKey,
  sharedResultKey,
  isSharedMediaObjectKey,
} from './shared-media-key.js';
import {
  SharedMediaCatalogService,
  type CommunityMediaObjects,
  type SharedMediaReady,
} from './shared-media-catalog.service.js';

export type SharedImportAction =
  'acquire' | 'source' | 'result' | 'wait' | 'failed';

export interface SharedMediaClaim {
  sourceKey: string;
  resultKey: string;
  cached: boolean;
  hasSource: boolean;
  waitingForDerivation?: boolean;
  waitingForCommunity?: boolean;
}

/** Durable shared artifacts. These collections and confirmed R2 objects have no TTL. */
@Injectable()
export class SharedMediaService {
  private reconciliationCursor?: string;

  constructor(
    @InjectModel(SharedMediaSource.name)
    readonly sources: Model<SharedMediaSource>,
    @InjectModel(SharedMediaResult.name)
    readonly results: Model<SharedMediaResult>,
    @InjectModel(MediaImport.name) private readonly imports: Model<MediaImport>,
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly storage: StorageTransfersService,
    private readonly transactions: ProcessingTransactions,
    @InjectModel(SharedMediaArtifact.name)
    readonly artifacts: Model<SharedMediaArtifact>,
    @Optional() private readonly catalog?: SharedMediaCatalogService,
  ) {}

  lookupSource(url: string) {
    if (!this.catalog) throw importError('IMPORT_DEPENDENCY_FAILED');
    return this.catalog.lookupSource(url);
  }

  lookupReady(url: string, trimEnabled = false, session?: ClientSession) {
    if (!this.catalog) throw importError('IMPORT_DEPENDENCY_FAILED');
    return this.catalog.lookupReady(url, trimEnabled, session);
  }

  reserveCommunity(
    contributionId: Types.ObjectId,
    url: string,
    session: ClientSession,
  ) {
    if (!this.catalog) throw importError('IMPORT_DEPENDENCY_FAILED');
    return this.catalog.reserveCommunity(contributionId, url, session);
  }

  refreshCommunityLease(
    contributionId: Types.ObjectId,
    url: string,
    expiresAt: Date,
    session: ClientSession,
  ) {
    if (!this.catalog) throw importError('IMPORT_DEPENDENCY_FAILED');
    return this.catalog.refreshCommunityLease(
      contributionId,
      url,
      expiresAt,
      session,
    );
  }

  inspectCommunity(url: string, session?: ClientSession) {
    if (!this.catalog) throw importError('IMPORT_DEPENDENCY_FAILED');
    return this.catalog.inspectCommunity(url, session);
  }

  failCommunity(
    contributionId: Types.ObjectId,
    url: string,
    session: ClientSession,
  ) {
    if (!this.catalog) throw importError('IMPORT_DEPENDENCY_FAILED');
    return this.catalog.failCommunity(contributionId, url, session);
  }

  publishCommunity(
    contributionId: Types.ObjectId,
    url: string,
    objects: CommunityMediaObjects,
  ) {
    if (!this.catalog) throw importError('IMPORT_DEPENDENCY_FAILED');
    return this.catalog.publishCommunity(contributionId, url, objects);
  }

  ensureReadyTrimmed(url: string) {
    if (!this.catalog) return Promise.resolve(null);
    return this.catalog.ensureReadyTrimmed(url);
  }

  ensureTrimmedFromFull(full: SharedMediaReady) {
    if (!this.catalog) return Promise.resolve(null);
    return this.catalog.ensureTrimmedFromFull(full);
  }

  async prepareRequestedOutput(job: Job, full: ObjectIdentity) {
    if (
      !this.catalog ||
      !job.requestedTrimEnabled ||
      !job.sharedSourceKey ||
      !job.sharedResultKey
    )
      return null;
    const source = await this.sources.findById(job.sharedSourceKey).lean();
    if (!source || !source.input || !source.inputObject || !job.recipeSnapshot)
      throw importError('IMPORT_DEPENDENCY_FAILED');
    return this.catalog.ensureTrimmedFromFull({
      sourceKey: source._id,
      resultKey: job.sharedResultKey,
      input: source.input,
      inputObject: source.inputObject,
      outputObject: full,
      recipeSnapshot: job.recipeSnapshot,
      comparisonRanges: null,
      sourceTitle: source.sourceTitle,
      provenance: source.provenance ?? 'trusted',
      sourceIdentityVerified: source.provenance !== 'community_contributed',
    });
  }

  async initialize() {
    await this.sources.init();
    await this.results.init();
    await this.artifacts.init();
  }

  /** Caller serializes URL admissions with the existing global import fence. */
  async claim(
    url: string,
    provider: string,
    importId: Types.ObjectId,
    trimEnabled: boolean,
    session: ClientSession,
    cacheOnly = false,
  ): Promise<SharedMediaClaim> {
    const ready = await this.catalog?.lookupReady(url, trimEnabled, session);
    if (ready)
      return {
        sourceKey: ready.sourceKey,
        resultKey: ready.resultKey,
        cached: true,
        hasSource: true,
      };
    if (!cacheOnly) {
      const pending = await this.catalog?.pending(url, trimEnabled, session);
      if (pending) return pending;
    }
    const sourceKey = sharedSourceKey(url);
    let source = await this.sources.findById(sourceKey).session(session).lean();
    if (cacheOnly && source?.state !== 'ready')
      throw importError('IMPORT_CACHE_MISS');
    if (!source || source.state === 'failed') {
      source = await this.sources
        .findOneAndUpdate(
          { _id: sourceKey },
          {
            $set: {
              sourceUrl: url,
              provider,
              generation: randomUUID(),
              state: 'acquiring',
              producerImportId: importId,
              input: null,
              inputKey: null,
              inputObject: null,
              sourceTitle: null,
              extraData: null,
              acquiredAt: null,
            },
          },
          {
            upsert: true,
            session,
            returnDocument: 'after',
            runValidators: true,
          },
        )
        .lean();
    }
    if (!source) throw importError('IMPORT_DEPENDENCY_FAILED');
    const recipe = workerRecipeSnapshot(
      DEFAULT_WORKER_RECIPE_ID,
      !cacheOnly && this.catalog && provider === 'youtube'
        ? false
        : trimEnabled,
    );
    const resultKey = sharedResultKey(
      sourceKey,
      source.generation,
      recipe.recipeDigest,
    );
    let result = await this.results.findById(resultKey).session(session).lean();
    const cached = Boolean(
      source.state === 'ready' &&
      source.input &&
      source.inputObject &&
      result?.state === 'ready' &&
      result.outputObject &&
      result.sourceKey === sourceKey &&
      result.sourceGeneration === source.generation &&
      result.recipeSnapshot.recipeDigest === recipe.recipeDigest,
    );
    if (cacheOnly) {
      if (!cached) throw importError('IMPORT_CACHE_MISS');
      return { sourceKey, resultKey, cached: true, hasSource: true };
    }
    if (!result || result.state === 'failed') {
      result = await this.results
        .findOneAndUpdate(
          { _id: resultKey },
          {
            $set: {
              sourceKey,
              sourceGeneration: source.generation,
              state: 'processing',
              producerImportId: importId,
              producerJobId: null,
              recipeSnapshot: recipe,
              outputKey: null,
              pendingOutput: null,
              outputObject: null,
              publicationToken: null,
              publicationLeaseUntil: null,
              comparisonRanges: null,
              completedAt: null,
            },
          },
          {
            upsert: true,
            session,
            returnDocument: 'after',
            runValidators: true,
          },
        )
        .lean();
    }
    return {
      sourceKey,
      resultKey,
      cached,
      hasSource: source.state === 'ready',
    };
  }

  async inspect(record: MediaImport, allowDerivation = true) {
    if (!record.sharedSourceKey || !record.sharedResultKey) return null;
    const [source, storedResult] = await Promise.all([
      this.sources.findById(record.sharedSourceKey).lean(),
      this.results.findById(record.sharedResultKey).lean(),
    ]);
    let result = storedResult;
    if (
      this.catalog &&
      record.trimEnabled &&
      result?.state === 'ready' &&
      result.outputObject &&
      !result.recipeSnapshot.trimEnabled &&
      source?.state === 'ready' &&
      source.input &&
      source.inputObject &&
      result.sourceKey === source._id &&
      result.sourceGeneration === source.generation
    ) {
      const full: SharedMediaReady = {
        sourceKey: source._id,
        resultKey: result._id,
        input: source.input!,
        inputObject: source.inputObject!,
        outputObject: result.outputObject!,
        recipeSnapshot: result.recipeSnapshot,
        comparisonRanges: result.comparisonRanges,
        sourceTitle: source.sourceTitle,
        provenance: source.provenance ?? 'trusted',
        sourceIdentityVerified: source.provenance !== 'community_contributed',
      };
      const existing = await this.catalog.lookupTrimmedForFull(full);
      const trimmed =
        existing ??
        (allowDerivation
          ? await this.catalog.ensureTrimmedFromFull(full)
          : null);
      if (!trimmed) return { action: 'wait' as const, source, result };
      if (trimmed.sourceKey !== source._id)
        return { action: 'wait' as const, source, result };
      result = await this.results.findById(trimmed.resultKey).lean();
    }
    let action: SharedImportAction = 'failed';
    if (
      source &&
      result &&
      result.sourceKey === source._id &&
      result.sourceGeneration === source.generation
    ) {
      if (
        result.state === 'ready' &&
        source.state === 'ready' &&
        result.outputObject &&
        source.inputObject &&
        source.input
      )
        action = 'result';
      else if (result.state === 'processing') {
        if (!result.producerImportId?.equals(record._id)) action = 'wait';
        else if (source.state === 'ready' && source.inputObject && source.input)
          action = 'source';
        else if (source.state === 'acquiring')
          action = source.producerImportId?.equals(record._id)
            ? 'acquire'
            : 'wait';
      }
    }
    return { action, source, result };
  }

  async reserveSource(
    record: MediaImport,
    input: InputDeclaration,
    sourceTitle: string | null = null,
    extraData: JobExtraData | null = null,
  ) {
    if (!record.sharedSourceKey) throw importError('IMPORT_DEPENDENCY_FAILED');
    const key = `shared/url/${record.sharedSourceKey}/${randomUUID()}/input/source.${input.extension}`;
    const source = await this.sources
      .findOneAndUpdate(
        {
          _id: record.sharedSourceKey,
          state: 'acquiring',
          producerImportId: record._id,
          inputKey: null,
        },
        {
          $set: {
            inputKey: key,
            input,
            sourceTitle,
            extraData: normalizeExtraData(extraData),
          },
        },
        { returnDocument: 'after', runValidators: true },
      )
      .lean();
    if (!source) throw importError('IMPORT_DEPENDENCY_FAILED');
    await this.artifacts.create({
      _id: key,
      assetKey: record.sharedSourceKey,
      kind: 'input',
      reservation: { ...input, key },
    });
    return { ...input, key };
  }

  sourceGrant(reservation: InputReservation) {
    return this.storage.createWorkerOutputGrant(
      reservation,
      new Date(Date.now() + 120_000),
    );
  }

  verifySource(reservation: InputReservation) {
    return this.storage.verifyInput({
      inputReservation: reservation,
      inputObject: null,
    });
  }

  /** Recover the recorded create-only PUT with one HEAD, without acquiring again. */
  async recoverSource(record: MediaImport) {
    if (!record.sharedSourceKey) return;
    const source = await this.sources.findById(record.sharedSourceKey).lean();
    if (
      source?.state !== 'acquiring' ||
      !source.producerImportId?.equals(record._id) ||
      !source.inputKey ||
      !source.input ||
      !isSharedMediaObjectKey(source.inputKey, source._id, 'input')
    )
      return;
    const object = await this.storage.findUploadedObject({
      ...source.input,
      key: source.inputKey,
    });
    if (object)
      await this.confirmSource(
        record,
        object,
        source.sourceTitle,
        source.extraData,
      );
  }

  async confirmSource(
    record: MediaImport,
    object: ObjectIdentity,
    sourceTitle: string | null,
    extraData: JobExtraData | null,
  ) {
    if (
      !record.sharedSourceKey ||
      !isSharedMediaObjectKey(object.key, record.sharedSourceKey, 'input')
    )
      throw importError('IMPORT_DEPENDENCY_FAILED');
    const saved = await this.sources.updateOne(
      {
        _id: record.sharedSourceKey,
        state: 'acquiring',
        producerImportId: record._id,
        inputKey: object.key,
        'input.sha256': object.sha256,
        'input.bytes': object.bytes,
      },
      {
        $set: {
          state: 'ready',
          inputObject: object,
          sourceTitle,
          extraData: normalizeExtraData(extraData),
          acquiredAt: new Date(),
        },
      },
      { runValidators: true },
    );
    if (saved.matchedCount !== 1) throw importError('IMPORT_DEPENDENCY_FAILED');
    await this.artifacts.updateOne({ _id: object.key }, { $set: { object } });
  }

  async associateJob(record: MediaImport, jobId: Types.ObjectId) {
    if (!record.sharedResultKey) return;
    await this.results.updateOne(
      {
        _id: record.sharedResultKey,
        state: 'processing',
        producerImportId: record._id,
        $or: [{ producerJobId: null }, { producerJobId: jobId }],
      },
      { $set: { producerJobId: jobId } },
    );
  }

  /** Stores a recoverable copy intent before I/O; concurrent completion calls use fresh keys. */
  async publishOutput(
    job: Job,
    output: ObjectIdentity,
  ): Promise<ObjectIdentity> {
    if (!job.sharedResultKey) return output;
    const result = await this.results.findById(job.sharedResultKey).lean();
    if (
      !result ||
      result.sourceKey !== job.sharedSourceKey ||
      result.recipeSnapshot.recipeDigest !== job.recipeSnapshot?.recipeDigest
    )
      throw importError('IMPORT_DEPENDENCY_FAILED');
    if (
      result.state !== 'processing' ||
      (result.producerJobId && !result.producerJobId.equals(job._id))
    )
      throw importError('IMPORT_DEPENDENCY_FAILED');
    if (result.outputObject) {
      if (!result.pendingOutput || !sameObject(result.pendingOutput, output))
        throw importError('IMPORT_DEPENDENCY_FAILED');
      return result.outputObject;
    }
    if (
      result.outputKey &&
      result.pendingOutput &&
      sameObject(result.pendingOutput, output) &&
      (!result.publicationLeaseUntil ||
        result.publicationLeaseUntil.getTime() <= Date.now())
    ) {
      const recovered = await this.storage.findUploadedObject({
        ...output,
        key: result.outputKey,
      });
      if (recovered) {
        const saved = await this.results.updateOne(
          {
            _id: result._id,
            state: 'processing',
            producerJobId: job._id,
            outputKey: recovered.key,
            outputObject: null,
            $or: [
              { publicationLeaseUntil: null },
              { publicationLeaseUntil: trusted({ $lte: new Date() }) },
            ],
          },
          {
            $set: {
              outputObject: recovered,
              publicationToken: null,
              publicationLeaseUntil: null,
            },
          },
          { runValidators: true },
        );
        if (saved.matchedCount !== 1)
          throw importError('IMPORT_DEPENDENCY_FAILED');
        await this.artifacts.updateOne(
          { _id: recovered.key },
          { $set: { object: recovered } },
        );
        return recovered;
      }
    }
    const token = randomUUID();
    const key = `shared/url/${result._id}/${randomUUID()}/output/vocals.mp3`;
    const claimed = await this.results
      .findOneAndUpdate(
        {
          _id: result._id,
          state: 'processing',
          outputObject: null,
          $and: [
            { $or: [{ producerJobId: job._id }, { producerJobId: null }] },
            {
              $or: [
                { publicationLeaseUntil: null },
                { publicationLeaseUntil: trusted({ $lte: new Date() }) },
              ],
            },
          ],
        },
        {
          $set: {
            producerJobId: job._id,
            pendingOutput: output,
            outputKey: key,
            publicationToken: token,
            publicationLeaseUntil: new Date(Date.now() + 90_000),
          },
        },
        { returnDocument: 'after', runValidators: true },
      )
      .lean();
    if (!claimed) throw importError('IMPORT_DEPENDENCY_FAILED');
    try {
      await this.artifacts.create({
        _id: key,
        assetKey: result._id,
        kind: 'output',
        reservation: { ...output, key },
      });
      // Copy a verified immutable worker output once; later users reference it.
      const copied = await this.storage.copyObject(output, key);
      const saved = await this.results.updateOne(
        {
          _id: result._id,
          state: 'processing',
          publicationToken: token,
          outputKey: key,
        },
        {
          $set: {
            outputObject: copied,
            publicationToken: null,
            publicationLeaseUntil: null,
          },
        },
        { runValidators: true },
      );
      if (saved.matchedCount !== 1)
        throw importError('IMPORT_DEPENDENCY_FAILED');
      await this.artifacts.updateOne(
        { _id: copied.key },
        { $set: { object: copied } },
      );
      return copied;
    } catch (error) {
      await this.results.updateOne(
        { _id: result._id, publicationToken: token },
        { $set: { publicationToken: null, publicationLeaseUntil: null } },
      );
      throw error;
    }
  }

  async completeResult(
    job: Job,
    object: ObjectIdentity,
    comparisonRanges: number[][] | null,
    session: ClientSession,
  ) {
    if (!job.sharedResultKey) return;
    const completed = await this.results.updateOne(
      {
        _id: job.sharedResultKey,
        sourceKey: job.sharedSourceKey,
        state: 'processing',
        producerJobId: job._id,
        'outputObject.key': object.key,
        'outputObject.etag': object.etag,
      },
      {
        $set: {
          state: 'ready',
          comparisonRanges,
          completedAt: new Date(),
          pendingOutput: null,
        },
      },
      { session, runValidators: true },
    );
    if (completed.matchedCount !== 1)
      throw importError('IMPORT_DEPENDENCY_FAILED');
  }

  async failImport(record: MediaImport) {
    if (!record.sharedSourceKey) return;
    await this.sources.updateOne(
      {
        _id: record.sharedSourceKey,
        state: 'acquiring',
        producerImportId: record._id,
      },
      { $set: { state: 'failed' } },
    );
    await this.results.updateOne(
      {
        _id: record.sharedResultKey,
        state: 'processing',
        producerImportId: record._id,
        producerJobId: null,
      },
      { $set: { state: 'failed' } },
    );
  }

  /** Recovery never resubmits a paid acquisition or fabricates a worker completion. */
  async reconcile() {
    await this.catalog?.reconcileDerived();
    const pending = await this.results
      .find({
        state: 'processing',
        ...(this.reconciliationCursor
          ? { _id: trusted({ $gt: this.reconciliationCursor }) }
          : {}),
      })
      .sort({ _id: 1 })
      .limit(100)
      .lean();
    for (const result of pending) {
      if (!result.producerImportId) continue;
      const producer = await this.imports
        .findById(result.producerImportId)
        .lean();
      const job = result.producerJobId
        ? await this.jobs.findById(result.producerJobId).lean()
        : producer
          ? await this.jobs
              .findOne({
                userId: producer.userId,
                requestId: producer.jobRequestId,
              })
              .lean()
          : null;
      if (job && !result.producerJobId)
        await this.results.updateOne(
          {
            _id: result._id,
            state: 'processing',
            producerJobId: null,
            producerImportId: result.producerImportId,
            sourceGeneration: result.sourceGeneration,
            updatedAt: result.updatedAt,
          },
          { $set: { producerJobId: job._id } },
        );
      if (
        job &&
        !job.deletedAt &&
        !['failed', 'cancelled'].includes(job.status)
      )
        continue;
      if (job || !producer || producer.status === 'failed') {
        await this.transactions.run(async (session) => {
          const failed = await this.results.updateOne(
            {
              _id: result._id,
              state: 'processing',
              producerImportId: result.producerImportId,
              producerJobId: result.producerJobId,
              sourceGeneration: result.sourceGeneration,
              updatedAt: result.updatedAt,
            },
            { $set: { state: 'failed' } },
            { session },
          );
          if (failed.matchedCount !== 1) return;
          await this.sources.updateOne(
            {
              _id: result.sourceKey,
              state: 'acquiring',
              producerImportId: result.producerImportId,
              generation: result.sourceGeneration,
            },
            { $set: { state: 'failed' } },
            { session },
          );
        });
      }
    }
    this.reconciliationCursor =
      pending.length === 100 ? pending.at(-1)!._id : undefined;
  }
}

function sameObject(left: ObjectIdentity, right: ObjectIdentity) {
  return (
    left.key === right.key &&
    left.etag === right.etag &&
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes &&
    left.contentType === right.contentType
  );
}
