import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { type ClientSession, type Model, type Types, trusted } from 'mongoose';
import { assertInputDeclaration } from '../jobs/job-state.js';
import { validComparisonRanges } from '../jobs/comparison-ranges.js';
import type {
  InputDeclaration,
  ObjectIdentity,
  WorkerRecipeSnapshot,
} from '../jobs/job.types.js';
import {
  DEFAULT_WORKER_RECIPE_ID,
  isWorkerRecipeSnapshot,
  workerRecipeSnapshot,
} from '../jobs/worker-recipes.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import {
  isStorageEtag,
  validateObjectReservation,
} from '../storage/object-identity.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import { importError } from '../url-imports/import-errors.js';
import { parseImportSource } from '../url-imports/import-source.js';
import {
  communitySourceKey,
  derivedResultKey,
  isSharedMediaObjectKey,
  sharedResultKey,
  sharedSourceKey,
} from './shared-media-key.js';
import {
  SharedMediaArtifact,
  SharedMediaResult,
  SharedMediaSource,
} from './shared-media.schema.js';
import { SharedMediaDerivationService } from './shared-media-derivation.service.js';
import {
  derivedTrimRecipe,
  DERIVED_TRIM_PROFILE,
} from './shared-media-trim.js';

export interface SharedMediaReady {
  sourceKey: string;
  resultKey: string;
  input: InputDeclaration;
  inputObject: ObjectIdentity;
  outputObject: ObjectIdentity;
  recipeSnapshot: WorkerRecipeSnapshot;
  comparisonRanges: number[][] | null;
  sourceTitle: string | null;
  provenance: 'trusted' | 'community_contributed';
  sourceIdentityVerified: boolean;
}
export interface CommunityMediaObjects {
  input: InputDeclaration;
  inputObject: ObjectIdentity;
  outputObject: ObjectIdentity;
  sourceTitle?: string | null;
}
export type CommunityReservation = {
  state: 'reserved' | 'waiting' | 'ready';
  sourceKey: string;
  resultKey: string;
  expiresAt: Date | null;
};

/** Accepted contributions and derivatives have no account-owned producer lifecycle. */
@Injectable()
export class SharedMediaCatalogService {
  private derivationCursor?: string;
  constructor(
    @InjectModel(SharedMediaSource.name)
    private readonly sources: Model<SharedMediaSource>,
    @InjectModel(SharedMediaResult.name)
    private readonly results: Model<SharedMediaResult>,
    @InjectModel(SharedMediaArtifact.name)
    private readonly artifacts: Model<SharedMediaArtifact>,
    private readonly storage: StorageTransfersService,
    private readonly transactions: ProcessingTransactions,
    private readonly derivation: SharedMediaDerivationService,
  ) {}

  /** Only backend-acquired immutable sources are eligible without a ready result. */
  async lookupSource(url: string) {
    const key = sharedSourceKey(parseImportSource(url).url);
    const source = await this.sources.findById(key).lean();
    if (
      !source ||
      source.state !== 'ready' ||
      !source.input ||
      !source.inputObject ||
      source.provenance === 'community_contributed' ||
      !isSharedMediaObjectKey(source.inputObject.key, key, 'input')
    )
      return null;
    assertInputDeclaration(source.input);
    this.assertIdentity(source.inputObject);
    if (
      source.input.bytes !== source.inputObject.bytes ||
      source.input.sha256 !== source.inputObject.sha256 ||
      source.input.contentType !== source.inputObject.contentType
    )
      return null;
    return { input: source.input, inputObject: source.inputObject };
  }

  async lookupReady(
    url: string,
    trimEnabled = false,
    session?: ClientSession,
  ): Promise<SharedMediaReady | null> {
    const parsed = parseImportSource(url);
    const keys = [
      sharedSourceKey(parsed.url),
      ...(parsed.provider === 'youtube'
        ? [communitySourceKey(parsed.url)]
        : []),
    ];
    for (const key of keys) {
      const source = await this.sources
        .findById(key)
        .session(session ?? null)
        .lean();
      if (
        source?._id !== key ||
        source.state !== 'ready' ||
        !source.input ||
        !source.inputObject
      )
        continue;
      const requested = workerRecipeSnapshot(
        DEFAULT_WORKER_RECIPE_ID,
        trimEnabled,
      );
      const candidates = [
        {
          recipe: requested,
          key: sharedResultKey(key, source.generation, requested.recipeDigest),
          master: null as SharedMediaResult | null,
        },
      ];
      if (trimEnabled) {
        const full = workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID, false);
        const master = await this.results
          .findById(sharedResultKey(key, source.generation, full.recipeDigest))
          .session(session ?? null)
          .lean();
        if (master?.state === 'ready' && master.outputObject) {
          const recipe = derivedTrimRecipe(full);
          candidates.push({
            recipe,
            key: derivedResultKey(
              key,
              source.generation,
              recipe.recipeDigest,
              master.outputObject,
            ),
            master,
          });
        }
      }
      for (const candidate of candidates) {
        const result = await this.results
          .findById(candidate.key)
          .session(session ?? null)
          .lean();
        const ready = this.ready(source, result, candidate.recipe.recipeDigest);
        if (ready) {
          if (candidate.master) {
            const master = candidate.master;
            if (
              result?.derivedFromResultKey !== master._id ||
              !result.derivedFromObject ||
              !sameObject(result.derivedFromObject, master.outputObject!) ||
              master.sourceKey !== source._id ||
              master.sourceGeneration !== source.generation
            )
              continue;
          }
          return ready;
        }
      }
    }
    return null;
  }

  /** A queued import keeps its accepted source and immutable master on read-only replay. */
  async lookupTrimmedForFull(
    full: SharedMediaReady,
    session?: ClientSession,
  ): Promise<SharedMediaReady | null> {
    const source = await this.sources
      .findById(full.sourceKey)
      .session(session ?? null)
      .lean();
    const master = await this.results
      .findById(full.resultKey)
      .session(session ?? null)
      .lean();
    if (
      !source ||
      !master ||
      !this.ready(source, master, full.recipeSnapshot.recipeDigest) ||
      master.recipeSnapshot.trimEnabled ||
      !sameObject(master.outputObject!, full.outputObject) ||
      !sameObject(source.inputObject!, full.inputObject) ||
      source.input!.durationSeconds !== full.input.durationSeconds
    )
      return null;
    const requested = workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID, true);
    const existing = await this.results
      .findById(
        sharedResultKey(source._id, source.generation, requested.recipeDigest),
      )
      .session(session ?? null)
      .lean();
    const ready = this.ready(source, existing, requested.recipeDigest);
    if (ready) return ready;
    const recipe = derivedTrimRecipe(master.recipeSnapshot);
    const derived = await this.results
      .findById(
        derivedResultKey(
          source._id,
          source.generation,
          recipe.recipeDigest,
          master.outputObject!,
        ),
      )
      .session(session ?? null)
      .lean();
    if (
      derived?.derivedFromResultKey !== master._id ||
      !derived.derivedFromObject ||
      !sameObject(derived.derivedFromObject, master.outputObject!)
    )
      return null;
    return this.ready(source, derived, recipe.recipeDigest);
  }

  /** Caller holds the same global admission fence as cloud URL imports. No I/O here. */
  async reserveCommunity(
    contributionId: Types.ObjectId,
    url: string,
    session: ClientSession,
  ): Promise<CommunityReservation> {
    const parsed = parseImportSource(url);
    const key = communitySourceKey(parsed.url);
    const full = workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID, false);
    const trustedSource = await this.sources
      .findById(sharedSourceKey(parsed.url))
      .session(session)
      .lean();
    if (trustedSource && trustedSource.state !== 'failed') {
      const resultKey = sharedResultKey(
        trustedSource._id,
        trustedSource.generation,
        full.recipeDigest,
      );
      const result = await this.results
        .findById(resultKey)
        .session(session)
        .lean();
      if (this.ready(trustedSource, result, full.recipeDigest))
        return {
          state: 'ready',
          sourceKey: trustedSource._id,
          resultKey,
          expiresAt: null,
        };
      if (trustedSource.state === 'acquiring' || result?.state === 'processing')
        return {
          state: 'waiting',
          sourceKey: trustedSource._id,
          resultKey,
          expiresAt: null,
        };
      const legacyTrim = await this.results
        .findById(
          sharedResultKey(
            trustedSource._id,
            trustedSource.generation,
            workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID, true).recipeDigest,
          ),
        )
        .session(session)
        .lean();
      if (legacyTrim?.state === 'processing')
        return {
          state: 'waiting',
          sourceKey: trustedSource._id,
          resultKey: legacyTrim._id,
          expiresAt: null,
        };
    }
    let source = await this.sources.findById(key).session(session).lean();
    if (
      !source ||
      source.state === 'failed' ||
      (source.state === 'acquiring' &&
        source.communityLeaseUntil &&
        source.communityLeaseUntil.getTime() <= Date.now())
    ) {
      source = await this.sources
        .findOneAndUpdate(
          { _id: key },
          {
            $set: {
              sourceUrl: parsed.url,
              provider: 'youtube',
              generation: randomUUID(),
              state: 'acquiring',
              producerImportId: null,
              communityContributionId: contributionId,
              communityLeaseUntil: new Date(Date.now() + 600_000),
              provenance: 'community_contributed',
              input: null,
              inputKey: null,
              pendingInput: null,
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
    const resultKey = sharedResultKey(
      key,
      source.generation,
      full.recipeDigest,
    );
    if (source.state === 'ready') {
      const result = await this.results
        .findById(resultKey)
        .session(session)
        .lean();
      if (
        !this.ready(source, result, full.recipeDigest) &&
        result?.state !== 'processing'
      )
        throw importError('IMPORT_DEPENDENCY_FAILED');
      return {
        state: this.ready(source, result, full.recipeDigest)
          ? 'ready'
          : 'waiting',
        sourceKey: key,
        resultKey,
        expiresAt: null,
      };
    }
    if (!source.communityContributionId?.equals(contributionId))
      return {
        state: 'waiting',
        sourceKey: key,
        resultKey,
        expiresAt: source.communityLeaseUntil ?? null,
      };
    await this.results.updateOne(
      { _id: resultKey },
      {
        $setOnInsert: {
          sourceKey: key,
          sourceGeneration: source.generation,
          state: 'processing',
          producerImportId: null,
          producerJobId: null,
          communityContributionId: contributionId,
          provenance: 'community_contributed',
          recipeSnapshot: full,
          outputKey: null,
          outputObject: null,
          pendingOutput: null,
          publicationToken: null,
          publicationLeaseUntil: null,
          comparisonRanges: null,
          completedAt: null,
        },
      },
      { upsert: true, session, runValidators: true },
    );
    return {
      state: 'reserved',
      sourceKey: key,
      resultKey,
      expiresAt: source.communityLeaseUntil ?? null,
    };
  }

  refreshCommunityLease(
    contributionId: Types.ObjectId,
    url: string,
    expiresAt: Date,
    session: ClientSession,
  ) {
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= Date.now() ||
      expiresAt.getTime() > Date.now() + 24 * 60 * 60 * 1000 + 1000
    )
      throw importError('IMPORT_DEPENDENCY_FAILED');
    return this.sources.updateOne(
      {
        _id: communitySourceKey(url),
        state: 'acquiring',
        communityContributionId: contributionId,
      },
      { $set: { communityLeaseUntil: expiresAt } },
      { session, runValidators: true },
    );
  }

  async inspectCommunity(url: string, session?: ClientSession) {
    const ready = await this.lookupReady(url, false, session);
    if (ready)
      return {
        state: 'ready' as const,
        expiresAt: null,
        sourceKey: ready.sourceKey,
        resultKey: ready.resultKey,
      };
    const keys = [sharedSourceKey(url), communitySourceKey(url)];
    for (const key of keys) {
      const source = await this.sources
        .findById(key)
        .session(session ?? null)
        .lean();
      if (
        !source ||
        source.state === 'failed' ||
        (source.communityLeaseUntil &&
          source.communityLeaseUntil.getTime() <= Date.now())
      )
        continue;
      const resultKey = sharedResultKey(
        key,
        source.generation,
        workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID, false).recipeDigest,
      );
      const result = await this.results
        .findById(resultKey)
        .session(session ?? null)
        .lean();
      if (source.state === 'acquiring' || result?.state === 'processing')
        return {
          state:
            source.state === 'acquiring'
              ? ('preparing' as const)
              : ('validating' as const),
          expiresAt: source.communityLeaseUntil ?? null,
          sourceKey: key,
          resultKey,
        };
    }
    return { state: 'missing' as const, expiresAt: null };
  }

  async failCommunity(
    contributionId: Types.ObjectId,
    url: string,
    session: ClientSession,
  ) {
    const key = communitySourceKey(url);
    const source = await this.sources.findById(key).session(session).lean();
    if (
      !source ||
      source.state !== 'acquiring' ||
      !source.communityContributionId?.equals(contributionId)
    )
      return;
    await this.sources.updateOne(
      {
        _id: key,
        generation: source.generation,
        state: 'acquiring',
        communityContributionId: contributionId,
      },
      { $set: { state: 'failed' } },
      { session },
    );
    await this.results.updateOne(
      {
        _id: sharedResultKey(
          key,
          source.generation,
          workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID, false).recipeDigest,
        ),
        state: 'processing',
        communityContributionId: contributionId,
      },
      {
        $set: {
          state: 'failed',
          publicationToken: null,
          publicationLeaseUntil: null,
        },
      },
      { session },
    );
  }

  /** Only pending community/derived work may be joined; never dispatch its recipe to a worker. */
  async pending(url: string, trimEnabled: boolean, session: ClientSession) {
    const parsed = parseImportSource(url);
    if (parsed.provider !== 'youtube') return null;
    const trustedSource = await this.sources
      .findById(sharedSourceKey(parsed.url))
      .session(session)
      .lean();
    if (trustedSource?.state === 'acquiring') return null;
    const keys = [sharedSourceKey(parsed.url), communitySourceKey(parsed.url)];
    for (const key of keys) {
      const source = await this.sources.findById(key).session(session).lean();
      if (!source || source.state === 'failed') continue;
      if (
        source.communityLeaseUntil &&
        source.state === 'acquiring' &&
        source.communityLeaseUntil.getTime() <= Date.now()
      )
        continue;
      const fullRecipe = workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID, false);
      if (trimEnabled && source.state === 'ready') {
        const master = await this.results
          .findById(
            sharedResultKey(key, source.generation, fullRecipe.recipeDigest),
          )
          .session(session)
          .lean();
        const resultKey = master?.outputObject
          ? derivedResultKey(
              key,
              source.generation,
              derivedTrimRecipe(fullRecipe).recipeDigest,
              master.outputObject,
            )
          : null;
        const result = resultKey
          ? await this.results.findById(resultKey).session(session).lean()
          : null;
        if (
          resultKey &&
          result?.state === 'processing' &&
          result.derivationProfileId === DERIVED_TRIM_PROFILE
        )
          return {
            sourceKey: key,
            resultKey,
            cached: false,
            hasSource: true,
            waitingForDerivation: true,
          };
      }
      if (
        source.provenance === 'community_contributed' &&
        source.state === 'acquiring'
      )
        return {
          sourceKey: key,
          resultKey: sharedResultKey(
            key,
            source.generation,
            fullRecipe.recipeDigest,
          ),
          cached: false,
          hasSource: false,
          waitingForCommunity: true,
        };
    }
    return null;
  }

  /** Inputs are verified quarantine objects supplied by the guest validation service. */
  async publishCommunity(
    contributionId: Types.ObjectId,
    url: string,
    objects: CommunityMediaObjects,
  ): Promise<SharedMediaReady> {
    const parsed = parseImportSource(url);
    const sourceKey = communitySourceKey(parsed.url);
    assertInputDeclaration(objects.input);
    this.assertIdentity(objects.inputObject);
    this.assertIdentity(objects.outputObject);
    if (
      objects.inputObject.bytes !== objects.input.bytes ||
      objects.inputObject.sha256 !== objects.input.sha256 ||
      objects.inputObject.contentType !== objects.input.contentType ||
      objects.outputObject.contentType !== 'audio/mpeg'
    )
      throw importError('IMPORT_INVALID_AUDIO');
    const prefix = `quarantine/youtube/${contributionId.toHexString()}/`;
    if (
      !objects.inputObject.key.startsWith(`${prefix}input/`) ||
      !objects.outputObject.key.startsWith(`${prefix}output/`)
    )
      throw importError('IMPORT_INVALID_AUDIO');
    const recipe = workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID, false);
    const token = randomUUID();
    const intent = await this.transactions.run(async (session) => {
      let source = await this.sources
        .findById(sourceKey)
        .session(session)
        .lean();
      if (!source) {
        await this.reserveCommunity(contributionId, parsed.url, session);
        source = await this.sources.findById(sourceKey).session(session).lean();
      }
      if (!source || source.provenance !== 'community_contributed')
        throw importError('IMPORT_DEPENDENCY_FAILED');
      const resultKey = sharedResultKey(
        sourceKey,
        source.generation,
        recipe.recipeDigest,
      );
      let result = await this.results
        .findById(resultKey)
        .session(session)
        .lean();
      const ready = this.ready(source, result, recipe.recipeDigest);
      if (ready) return { ready, source, result: result!, token: null };
      if (
        source.state !== 'acquiring' ||
        !source.communityContributionId?.equals(contributionId) ||
        (source.pendingInput &&
          !sameObject(source.pendingInput, objects.inputObject)) ||
        !result ||
        result.state !== 'processing' ||
        (result.pendingOutput &&
          !sameObject(result.pendingOutput, objects.outputObject)) ||
        (result.publicationLeaseUntil &&
          result.publicationLeaseUntil.getTime() > Date.now())
      )
        throw importError('IMPORT_DEPENDENCY_FAILED');
      if (!source.inputKey)
        source = await this.sources
          .findOneAndUpdate(
            {
              _id: sourceKey,
              generation: source.generation,
              state: 'acquiring',
            },
            {
              $set: {
                input: objects.input,
                inputKey: `shared/url/${sourceKey}/${randomUUID()}/input/source.${objects.input.extension}`,
                pendingInput: objects.inputObject,
                sourceTitle: this.title(objects.sourceTitle),
              },
            },
            { session, returnDocument: 'after', runValidators: true },
          )
          .lean();
      if (!source?.inputKey) throw importError('IMPORT_DEPENDENCY_FAILED');
      result = await this.results
        .findOneAndUpdate(
          {
            _id: resultKey,
            state: 'processing',
            publicationToken: result.publicationToken,
          },
          {
            $set: {
              outputKey:
                result.outputKey ??
                `shared/url/${resultKey}/${randomUUID()}/output/vocals.mp3`,
              pendingOutput: objects.outputObject,
              publicationToken: token,
              publicationLeaseUntil: new Date(Date.now() + 180_000),
            },
          },
          { session, returnDocument: 'after', runValidators: true },
        )
        .lean();
      if (!result?.outputKey) throw importError('IMPORT_DEPENDENCY_FAILED');
      await this.reserveArtifact(
        source.inputKey,
        sourceKey,
        'input',
        objects.inputObject,
        session,
      );
      await this.reserveArtifact(
        result.outputKey,
        resultKey,
        'output',
        objects.outputObject,
        session,
      );
      return { ready: null, source, result, token };
    });
    if (intent.ready) return intent.ready;
    try {
      const input = await this.copyOrRecover(
        objects.inputObject,
        intent.source.inputKey!,
      );
      const output = await this.copyOrRecover(
        objects.outputObject,
        intent.result.outputKey!,
      );
      await this.transactions.run(async (session) => {
        const saved = await this.results.updateOne(
          {
            _id: intent.result._id,
            state: 'processing',
            publicationToken: token,
          },
          {
            $set: {
              state: 'ready',
              outputObject: output,
              pendingOutput: null,
              comparisonRanges: null,
              completedAt: new Date(),
              publicationToken: null,
              publicationLeaseUntil: null,
            },
          },
          { session, runValidators: true },
        );
        if (saved.matchedCount !== 1)
          throw importError('IMPORT_DEPENDENCY_FAILED');
        const accepted = await this.sources.updateOne(
          {
            _id: sourceKey,
            generation: intent.source.generation,
            communityContributionId: contributionId,
            state: 'acquiring',
          },
          {
            $set: {
              state: 'ready',
              inputObject: input,
              pendingInput: null,
              acquiredAt: new Date(),
            },
          },
          { session, runValidators: true },
        );
        if (accepted.matchedCount !== 1)
          throw importError('IMPORT_DEPENDENCY_FAILED');
        await this.artifacts.updateOne(
          { _id: input.key },
          { $set: { object: input } },
          { session },
        );
        await this.artifacts.updateOne(
          { _id: output.key },
          { $set: { object: output } },
          { session },
        );
      });
      const ready = this.ready(
        { ...intent.source, state: 'ready', inputObject: input },
        { ...intent.result, state: 'ready', outputObject: output },
        recipe.recipeDigest,
      );
      if (!ready) throw importError('IMPORT_DEPENDENCY_FAILED');
      return ready;
    } catch (error) {
      await this.releaseLease(intent.result._id, token);
      throw error;
    }
  }

  /** Call before admission, outside its transaction; one derived result serves every owner. */
  async ensureReadyTrimmed(url: string): Promise<SharedMediaReady | null> {
    const existing = await this.lookupReady(url, true);
    if (existing) return existing;
    const full = await this.lookupReady(url, false);
    if (!full) return null;
    return this.ensureTrimmedFromFull(full);
  }

  /** Completion can prepare a rendition; lookup exposes it only once its master is ready. */
  async ensureTrimmedFromFull(
    full: SharedMediaReady,
  ): Promise<SharedMediaReady | null> {
    const source = await this.sources.findById(full.sourceKey).lean();
    if (!source || source.state !== 'ready') return null;
    const master = await this.results.findById(full.resultKey).lean();
    if (
      !master ||
      !['processing', 'ready'].includes(master.state) ||
      !master.outputObject ||
      !sameObject(master.outputObject, full.outputObject) ||
      !source.input ||
      !source.inputObject ||
      !sameObject(source.inputObject, full.inputObject) ||
      source.input.durationSeconds !== full.input.durationSeconds ||
      master.recipeSnapshot.recipeDigest !== full.recipeSnapshot.recipeDigest ||
      master.sourceKey !== source._id ||
      master.sourceGeneration !== source.generation ||
      master.recipeSnapshot.trimEnabled ||
      !isWorkerRecipeSnapshot(master.recipeSnapshot)
    )
      throw importError('IMPORT_DEPENDENCY_FAILED');
    const recipe = derivedTrimRecipe(master.recipeSnapshot);
    const resultKey = derivedResultKey(
      full.sourceKey,
      source.generation,
      recipe.recipeDigest,
      full.outputObject,
    );
    const token = randomUUID();
    const result = await this.transactions.run(async (session) => {
      let candidate = await this.results
        .findById(resultKey)
        .session(session)
        .lean();
      if (candidate?.state === 'ready') return candidate;
      if (!candidate)
        candidate = await this.results
          .findOneAndUpdate(
            { _id: resultKey },
            {
              $setOnInsert: {
                sourceKey: full.sourceKey,
                sourceGeneration: source.generation,
                state: 'processing',
                producerImportId: null,
                producerJobId: null,
                provenance: full.provenance,
                recipeSnapshot: recipe,
                derivedFromResultKey: full.resultKey,
                derivedFromObject: full.outputObject,
                derivationProfileId: DERIVED_TRIM_PROFILE,
                outputKey: null,
                outputObject: null,
                pendingOutput: null,
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
      if (
        !candidate ||
        candidate.derivedFromResultKey !== full.resultKey ||
        !candidate.derivedFromObject ||
        !sameObject(candidate.derivedFromObject, full.outputObject) ||
        (candidate.publicationLeaseUntil &&
          candidate.publicationLeaseUntil.getTime() > Date.now())
      )
        return null;
      return this.results
        .findOneAndUpdate(
          {
            _id: resultKey,
            state: 'processing',
            publicationToken: candidate.publicationToken,
          },
          {
            $set: {
              publicationToken: token,
              publicationLeaseUntil: new Date(Date.now() + 240_000),
            },
          },
          { session, returnDocument: 'after', runValidators: true },
        )
        .lean();
    });
    if (!result) return null;
    if (result.state === 'ready')
      return this.ready(source, result, recipe.recipeDigest);
    try {
      if (result.outputKey && result.pendingOutput) {
        const recovered = await this.storage.findUploadedObject({
          ...result.pendingOutput,
          key: result.outputKey,
        });
        if (recovered)
          return await this.completeDerivative(
            source,
            result,
            recovered,
            token,
          );
      }
      return await this.derivation.derive(
        full.outputObject,
        full.input.durationSeconds,
        async (file) => {
          const key = `shared/url/${resultKey}/${randomUUID()}/output/vocals.mp3`;
          const pending = {
            key,
            bytes: file.bytes,
            sha256: file.sha256,
            contentType: 'audio/mpeg',
            etag: '"pending"',
          };
          await this.transactions.run(async (session) => {
            const saved = await this.results.updateOne(
              { _id: resultKey, state: 'processing', publicationToken: token },
              {
                $set: {
                  outputKey: key,
                  pendingOutput: pending,
                  comparisonRanges: file.comparisonRanges,
                },
              },
              { session, runValidators: true },
            );
            if (saved.matchedCount !== 1)
              throw importError('IMPORT_DEPENDENCY_FAILED');
            await this.reserveArtifact(
              key,
              resultKey,
              'output',
              pending,
              session,
            );
          });
          await this.derivation.upload(file, key);
          const output = await this.storage.findUploadedObject(pending);
          if (!output) throw importError('IMPORT_DEPENDENCY_FAILED');
          return this.completeDerivative(
            source,
            {
              ...result,
              outputKey: key,
              comparisonRanges: file.comparisonRanges,
            },
            output,
            token,
          );
        },
      );
    } catch (error) {
      await this.releaseLease(resultKey, token);
      throw error;
    }
  }

  async reconcileDerived() {
    const candidates = await this.results
      .find({
        state: 'processing',
        derivationProfileId: DERIVED_TRIM_PROFILE,
        ...(this.derivationCursor
          ? { _id: trusted({ $gt: this.derivationCursor }) }
          : {}),
        $or: [
          { publicationLeaseUntil: null },
          { publicationLeaseUntil: trusted({ $lte: new Date() }) },
        ],
      })
      .sort({ _id: 1 })
      .limit(1)
      .lean();
    for (const result of candidates) {
      const source = await this.sources.findById(result.sourceKey).lean();
      const master = result.derivedFromResultKey
        ? await this.results.findById(result.derivedFromResultKey).lean()
        : null;
      const ready =
        source && master
          ? this.ready(source, master, master.recipeSnapshot.recipeDigest)
          : null;
      if (
        ready &&
        result.derivedFromObject &&
        sameObject(result.derivedFromObject, ready.outputObject)
      ) {
        try {
          await this.ensureTrimmedFromFull(ready);
        } catch {
          /* Durable intent remains eligible for the next bounded reconciliation. */
        }
      }
    }
    this.derivationCursor = candidates.length
      ? candidates[candidates.length - 1]!._id
      : undefined;
  }

  private async completeDerivative(
    source: SharedMediaSource,
    result: SharedMediaResult,
    output: ObjectIdentity,
    token: string,
  ) {
    await this.transactions.run(async (session) => {
      const saved = await this.results.updateOne(
        {
          _id: result._id,
          state: 'processing',
          publicationToken: token,
          outputKey: output.key,
        },
        {
          $set: {
            state: 'ready',
            outputObject: output,
            pendingOutput: null,
            completedAt: new Date(),
            publicationToken: null,
            publicationLeaseUntil: null,
          },
        },
        { session, runValidators: true },
      );
      if (saved.matchedCount !== 1)
        throw importError('IMPORT_DEPENDENCY_FAILED');
      await this.artifacts.updateOne(
        { _id: output.key },
        { $set: { object: output } },
        { session },
      );
    });
    const ready = this.ready(
      source,
      { ...result, state: 'ready', outputObject: output },
      result.recipeSnapshot.recipeDigest,
    );
    if (!ready) throw importError('IMPORT_DEPENDENCY_FAILED');
    return ready;
  }

  private ready(
    source: SharedMediaSource,
    result: SharedMediaResult | null,
    digest: string,
  ): SharedMediaReady | null {
    if (
      !source.input ||
      !source.inputObject ||
      source.state !== 'ready' ||
      !result ||
      result.state !== 'ready' ||
      !result.outputObject ||
      result.sourceKey !== source._id ||
      result.sourceGeneration !== source.generation ||
      result.recipeSnapshot.recipeDigest !== digest ||
      !isWorkerRecipeSnapshot(result.recipeSnapshot) ||
      !isSharedMediaObjectKey(source.inputObject.key, source._id, 'input') ||
      !isSharedMediaObjectKey(result.outputObject.key, result._id, 'output') ||
      (result.comparisonRanges !== null &&
        !validComparisonRanges(result.comparisonRanges))
    )
      return null;
    return {
      sourceKey: source._id,
      resultKey: result._id,
      input: source.input,
      inputObject: source.inputObject,
      outputObject: result.outputObject,
      recipeSnapshot: result.recipeSnapshot,
      comparisonRanges: result.comparisonRanges,
      sourceTitle: source.sourceTitle,
      provenance: source.provenance ?? 'trusted',
      sourceIdentityVerified: source.provenance !== 'community_contributed',
    };
  }
  private async reserveArtifact(
    key: string,
    assetKey: string,
    kind: 'input' | 'output',
    original: ObjectIdentity,
    session: ClientSession,
  ) {
    const { etag: _etag, ...reservation } = original;
    await this.artifacts.updateOne(
      { _id: key },
      {
        $setOnInsert: {
          assetKey,
          kind,
          reservation: { ...reservation, key },
          object: null,
        },
      },
      { upsert: true, session, runValidators: true },
    );
  }
  private async copyOrRecover(original: ObjectIdentity, key: string) {
    return (
      (await this.storage.findUploadedObject({ ...original, key })) ??
      (await this.storage.copyObject(original, key))
    );
  }
  private releaseLease(resultKey: string, token: string) {
    return this.results.updateOne(
      { _id: resultKey, publicationToken: token },
      { $set: { publicationToken: null, publicationLeaseUntil: null } },
    );
  }
  private assertIdentity(object: ObjectIdentity) {
    validateObjectReservation(object);
    if (!isStorageEtag(object.etag)) throw importError('IMPORT_INVALID_AUDIO');
  }
  private title(value: string | null | undefined) {
    return (
      value
        ?.replace(/\p{Cc}/gu, '')
        .trim()
        .slice(0, 200) || null
    );
  }
}

function sameObject(left: ObjectIdentity, right: ObjectIdentity) {
  return (
    left.key === right.key &&
    left.etag === right.etag &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.contentType === right.contentType
  );
}
