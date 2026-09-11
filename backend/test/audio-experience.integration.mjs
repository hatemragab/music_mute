import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startAudioProcessingFixture } from './helpers/audio-processing-fixture.mjs';

const input = {
  extension: 'mp3',
  contentType: 'audio/mpeg',
  bytes: 1024,
  durationSeconds: 30,
  sha256: Buffer.alloc(32, 7).toString('base64'),
};

const report = (operationId, overrides = {}) => ({
  eventId: randomUUID(),
  operationId,
  stage: 'PREPARING_INPUT',
  code: 'LOCAL_IO',
  retryable: true,
  platform: 'ios',
  appVersion: '1.0.0',
  osVersion: '26.0',
  occurredAt: new Date().toISOString(),
  ...overrides,
});

test(
  'audio experience preserves identity, timing, diagnostics, and deletion boundaries',
  { timeout: 30_000 },
  async (t) => {
    const f = await startAudioProcessingFixture(t);

    const legacyRequestId = randomUUID();
    const legacy = await f.request('POST', '/jobs', {
      requestId: legacyRequestId,
      input,
    });
    assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
    assert.equal(legacy.body.requestId, legacyRequestId);
    const legacyReplay = await f.request('POST', '/jobs', {
      requestId: legacyRequestId,
      input,
    });
    assert.equal(legacyReplay.status, 201);
    assert.equal(legacyReplay.body.id, legacy.body.id);

    const operationId = randomUUID();
    const clientStartedAt = new Date(Date.now() - 5_000).toISOString();
    const preJobReport = report(operationId);
    assert.equal(
      (await f.request('POST', '/client-errors', preJobReport, 'anonymous'))
        .status,
      401,
    );
    const accepted = await f.request('POST', '/client-errors', preJobReport);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.deepEqual(accepted.body, { eventId: preJobReport.eventId });
    assert.equal(
      (await f.request('POST', '/client-errors', preJobReport)).status,
      201,
    );
    assert.equal(
      (
        await f.request('POST', '/client-errors', {
          ...preJobReport,
          code: 'NETWORK',
        })
      ).status,
      409,
    );

    const created = await f.request('POST', '/jobs', {
      requestId: operationId,
      input,
      sourceTitle: '  لقاء صوتي  ',
      sourceKind: 'url',
      sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      clientStartedAt,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.requestId, operationId);
    const detail = await f.request('GET', `/jobs/${created.body.id}`);
    assert.equal(detail.body.sourceTitle, 'لقاء صوتي');
    assert.equal(detail.body.displayName, 'لقاء صوتي');
    assert.equal(detail.body.sourceKind, 'url');

    const renamed = await f.request('PATCH', `/jobs/${created.body.id}`, {
      displayName: '  صوت فقط  ',
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.displayName, 'صوت فقط');
    assert.equal(
      (
        await f.request(
          'PATCH',
          `/jobs/${created.body.id}`,
          { displayName: 'ليس لك' },
          'other',
        )
      ).status,
      404,
    );

    const stored = await f.jobs.findById(created.body.id).lean();
    assert.equal(
      stored.sourceUrl,
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    );
    const inputObject = f.fakeStorage.put(stored.inputReservation);
    await f.jobs.updateOne(
      { _id: stored._id },
      {
        $set: {
          inputObject,
          status: 'failed',
          finishedAt: new Date(),
          lastError: {
            code: 'SEPARATOR_FAILED',
            message: 'Processing failed.',
            at: new Date(),
          },
        },
      },
    );
    const retryRequestId = randomUUID();
    const retry = await f.request('POST', `/jobs/${created.body.id}/retry`, {
      requestId: retryRequestId,
    });
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.equal(retry.body.retryOfJobId, created.body.id);
    const retryDetail = await f.request('GET', `/jobs/${retry.body.id}`);
    assert.equal(retryDetail.body.displayName, 'صوت فقط');
    assert.equal(retryDetail.body.sourceTitle, 'لقاء صوتي');
    assert.equal(
      (await f.jobs.findById(retry.body.id).lean()).sourceUrl,
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    );
    await f.jobs.updateOne(
      { _id: retry.body.id },
      { $set: { status: 'cancelled', finishedAt: new Date() } },
    );

    const attachedReport = report(operationId, { jobId: created.body.id });
    assert.equal(
      (await f.request('POST', '/client-errors', attachedReport)).status,
      201,
    );
    assert.equal(
      (
        await f.request(
          'POST',
          '/client-errors',
          report(operationId, { jobId: created.body.id }),
          'other',
        )
      ).status,
      404,
    );
    const diagnostic = await f.clientErrors.findOne({
      operationId,
      eventId: preJobReport.eventId,
    });
    assert.equal(diagnostic.jobId, null);
    assert.equal(
      (
        await f.jobs.findOne({ requestId: diagnostic.operationId }).lean()
      )._id.toHexString(),
      created.body.id,
    );

    const timedRequestId = randomUUID();
    const timed = await f.request('POST', '/jobs', {
      requestId: timedRequestId,
      input,
    });
    const timedJob = await f.jobs.findById(timed.body.id).lean();
    f.fakeStorage.put(timedJob.inputReservation);
    assert.equal(
      (await f.request('POST', `/jobs/${timed.body.id}/upload-complete`, {}))
        .status,
      200,
    );
    const claim = await f.request(
      'POST',
      '/worker/claim',
      { sessionId: randomUUID() },
      'worker',
    );
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    const selector = {
      jobId: claim.body.jobId,
      attemptId: claim.body.attemptId,
      sessionId: claim.body.sessionId,
      generation: claim.body.generation,
    };
    const stageEvent = {
      ...selector,
      eventId: randomUUID(),
      stage: 'processing',
      durationSeconds: 30,
      decodable: true,
      hasAudio: true,
    };
    assert.equal(
      (await f.request('POST', '/worker/stage', stageEvent, 'worker')).status,
      200,
    );
    const entered = await f.jobs.findById(selector.jobId).lean();
    assert.equal(
      (await f.request('POST', '/worker/stage', stageEvent, 'worker')).status,
      200,
    );
    const replayed = await f.jobs.findById(selector.jobId).lean();
    assert.equal(
      replayed.processingIntervalStartedAt.toISOString(),
      entered.processingIntervalStartedAt.toISOString(),
    );
    assert.equal(
      await f.receipts.countDocuments({ eventId: stageEvent.eventId }),
      1,
    );

    await f.jobs.updateOne(
      { _id: selector.jobId },
      {
        $set: {
          processingIntervalStartedAt: new Date(Date.now() - 20_000),
          processingObservedAt: new Date(),
        },
      },
    );
    const output = {
      ...selector,
      eventId: randomUUID(),
      bytes: 900,
      durationSeconds: 30,
      sha256: input.sha256,
      contentType: 'audio/mpeg',
      playable: true,
      voiceOnly: true,
    };
    assert.equal(
      (await f.request('POST', '/worker/output-url', output, 'worker')).status,
      200,
    );
    const timedDetail = await f.request('GET', `/jobs/${selector.jobId}`);
    assert.ok(timedDetail.body.timing.processingElapsedMs >= 19_000);
    assert.ok(timedDetail.body.timing.processingElapsedMs < 25_000);

    const activeDelete = await f.request('DELETE', `/jobs/${selector.jobId}`);
    assert.equal(activeDelete.status, 409);
    assert.equal(activeDelete.body.code, 'JOB_ACTIVE');
    assert.equal(
      (
        await f.request(
          'DELETE',
          `/jobs/${created.body.id}`,
          undefined,
          'other',
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.request('DELETE', `/jobs/${created.body.id}`)).status,
      204,
    );
    assert.equal(
      (await f.request('DELETE', `/jobs/${created.body.id}`)).status,
      204,
    );
    assert.equal(
      (await f.request('GET', `/jobs/${created.body.id}`)).status,
      404,
    );
    assert.equal(
      (await f.jobs.findById(created.body.id).lean()).sourceUrl,
      null,
    );
    const countBeforeReplay = await f.jobs.countDocuments({
      requestId: operationId,
    });
    assert.equal(
      (
        await f.request('POST', '/jobs', {
          requestId: operationId,
          input,
          sourceTitle: '  لقاء صوتي  ',
          sourceKind: 'url',
          sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
          clientStartedAt,
        })
      ).status,
      404,
    );
    assert.equal(
      await f.jobs.countDocuments({ requestId: operationId }),
      countBeforeReplay,
    );
    const history = await f.request('GET', '/jobs?limit=100');
    assert.equal(
      history.body.items.some((job) => job.id === created.body.id),
      false,
    );

    const sharedInputKey = stored.inputReservation.key;
    await f.jobs.updateOne(
      { _id: created.body.id },
      { $set: { cleanupNextAt: new Date(0) } },
    );
    assert.equal(await f.deletion.cleanupDue(new Date()), true);
    assert.equal(f.fakeStorage.objects.has(sharedInputKey), true);
    assert.equal(
      (await f.jobs.findById(created.body.id).lean())
        .cleanupCompletedAt instanceof Date,
      true,
    );

    assert.equal(
      (await f.request('DELETE', `/jobs/${retry.body.id}`)).status,
      204,
    );
    await f.jobs.updateOne(
      { _id: retry.body.id },
      { $set: { cleanupNextAt: new Date(0) } },
    );
    assert.equal(await f.deletion.cleanupDue(new Date()), true);
    assert.equal(f.fakeStorage.objects.has(sharedInputKey), false);
    assert.equal(f.fakeStorage.deletedKeys.includes(sharedInputKey), true);
    assert.equal(
      (await f.request('GET', `/jobs/${retry.body.id}`)).status,
      404,
    );

    const readyStored = await f.jobs.findById(legacy.body.id).lean();
    const readyInput = f.fakeStorage.put(readyStored.inputReservation);
    await f.jobs.updateOne(
      { _id: readyStored._id },
      {
        $set: {
          inputObject: readyInput,
          status: 'ready',
          finishedAt: new Date(),
        },
      },
    );
    assert.equal(
      (await f.request('DELETE', `/jobs/${legacy.body.id}`)).status,
      204,
    );

    const cleanupFailure = await f.request('POST', '/jobs', {
      requestId: randomUUID(),
      input,
    });
    const cleanupFailureStored = await f.jobs
      .findById(cleanupFailure.body.id)
      .lean();
    const cleanupFailureInput = f.fakeStorage.put(
      cleanupFailureStored.inputReservation,
    );
    await f.jobs.updateOne(
      { _id: cleanupFailureStored._id },
      {
        $set: {
          inputObject: cleanupFailureInput,
          status: 'cancelled',
          finishedAt: new Date(),
        },
      },
    );
    assert.equal(
      (await f.request('DELETE', `/jobs/${cleanupFailure.body.id}`)).status,
      204,
    );
    await f.jobs.updateOne(
      { _id: cleanupFailure.body.id },
      { $set: { cleanupNextAt: new Date(0) } },
    );
    f.fakeStorage.failNext('deleteVersionsForKey');
    assert.equal(await f.deletion.cleanupDue(new Date()), true);
    const pendingCleanup = await f.jobs.findById(cleanupFailure.body.id).lean();
    assert.equal(pendingCleanup.cleanupAttempts, 1);
    assert.equal(pendingCleanup.cleanupCompletedAt, null);
    assert.equal(
      (await f.request('GET', `/jobs/${cleanupFailure.body.id}`)).status,
      404,
    );
    await f.jobs.updateOne(
      { _id: cleanupFailure.body.id },
      { $set: { cleanupNextAt: new Date(0) } },
    );
    assert.equal(await f.deletion.cleanupDue(new Date()), true);
    assert.equal(
      (await f.jobs.findById(cleanupFailure.body.id).lean())
        .cleanupCompletedAt instanceof Date,
      true,
    );

    // A crashed replica's expired claim must be recoverable, with attempts
    // paged across sweeps and another replica excluded while storage is busy.
    const attemptKeys = [];
    for (let index = 0; index < 11; index += 1) {
      const attemptId = randomUUID();
      const reservation = {
        key: `users/${readyStored.userId}/jobs/${legacy.body.id}/attempt-${index}.mp3`,
        attemptId,
        bytes: input.bytes,
        durationSeconds: input.durationSeconds,
        sha256: input.sha256,
        contentType: input.contentType,
      };
      attemptKeys.push(reservation.key);
      f.fakeStorage.put(reservation);
      await f.attempts.create({
        workerId: 'z440',
        jobId: readyStored._id,
        attemptId,
        sessionId: randomUUID(),
        generation: index + 1,
        startedAt: new Date(),
        outputReservation: reservation,
      });
    }
    await f.jobs.updateOne(
      { _id: readyStored._id },
      {
        $set: {
          cleanupNextAt: new Date(0),
          cleanupLeaseUntil: new Date(0),
          cleanupToken: randomUUID(),
        },
      },
    );
    const transfers = f.fakeStorage.providers.transfers;
    const originalDelete = transfers.deleteVersionsForKey;
    let releaseStorage;
    let storageEntered;
    const enteredStorage = new Promise((resolve) => {
      storageEntered = resolve;
    });
    const storageGate = new Promise((resolve) => {
      releaseStorage = resolve;
    });
    transfers.deleteVersionsForKey = async (key) => {
      storageEntered();
      await storageGate;
      return originalDelete(key);
    };
    const firstSweep = f.deletion.cleanupDue(new Date());
    try {
      await enteredStorage;
      assert.equal(await f.deletion.cleanupDue(new Date()), false);
    } finally {
      releaseStorage();
      await firstSweep;
      transfers.deleteVersionsForKey = originalDelete;
    }
    const firstPage = await f.jobs.findById(readyStored._id).lean();
    assert.equal(firstPage.cleanupCompletedAt, null);
    assert.ok(firstPage.cleanupCursor);
    assert.equal(
      attemptKeys.filter((key) => f.fakeStorage.objects.has(key)).length,
      1,
    );
    await f.jobs.updateOne(
      { _id: readyStored._id },
      { $set: { cleanupNextAt: new Date(0) } },
    );
    assert.equal(await f.deletion.cleanupDue(new Date()), true);
    assert.equal(
      attemptKeys.some((key) => f.fakeStorage.objects.has(key)),
      false,
    );
    assert.ok(
      (await f.jobs.findById(readyStored._id).lean()).cleanupCompletedAt,
    );

    // Pause retry after its transactional source read: delete and clean the
    // input before retry continues. The stale snapshot must never create a job.
    const race = await f.request('POST', '/jobs', {
      requestId: randomUUID(),
      input,
    });
    assert.equal(race.status, 201);
    const raceStored = await f.jobs.findById(race.body.id).lean();
    const raceInput = f.fakeStorage.put(raceStored.inputReservation);
    await f.jobs.updateOne(
      { _id: raceStored._id },
      {
        $set: {
          inputObject: raceInput,
          status: 'failed',
          finishedAt: new Date(),
        },
      },
    );
    const retryIdentity = randomUUID();
    const originalFindOne = f.jobs.findOne;
    let releaseRetry;
    let sourceRead;
    let pauseSource = true;
    const sourceWasRead = new Promise((resolve) => {
      sourceRead = resolve;
    });
    const retryGate = new Promise((resolve) => {
      releaseRetry = resolve;
    });
    f.jobs.findOne = function (...args) {
      const query = originalFindOne.apply(this, args);
      const originalExec = query.exec;
      query.exec = async function (...execArgs) {
        const result = await originalExec.apply(this, execArgs);
        if (
          pauseSource &&
          this.getOptions().session &&
          String(this.getFilter()._id) === race.body.id
        ) {
          pauseSource = false;
          sourceRead();
          await retryGate;
        }
        return result;
      };
      return query;
    };
    const retryPending = f.request('POST', `/jobs/${race.body.id}/retry`, {
      requestId: retryIdentity,
    });
    let raceRetry;
    try {
      await sourceWasRead;
      const raceDelete = await f.request('DELETE', `/jobs/${race.body.id}`);
      assert.equal(raceDelete.status, 204, JSON.stringify(raceDelete.body));
      await f.jobs.updateOne(
        { _id: raceStored._id },
        { $set: { cleanupNextAt: new Date(0) } },
      );
      assert.equal(await f.deletion.cleanupDue(new Date()), true);
      assert.equal(f.fakeStorage.objects.has(raceInput.key), false);
    } finally {
      releaseRetry();
      raceRetry = await retryPending;
      f.jobs.findOne = originalFindOne;
    }
    assert.equal(raceRetry.status, 404, JSON.stringify(raceRetry.body));
    assert.equal(await f.jobs.countDocuments({ requestId: retryIdentity }), 0);
    assert.equal((await f.request('GET', `/jobs/${race.body.id}`)).status, 404);
  },
);
