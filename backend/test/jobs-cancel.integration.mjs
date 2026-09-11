import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startAudioProcessingFixture } from './helpers/audio-processing-fixture.mjs';

test('cancellation retains the active slot until stopped and failures are safe and retryable', async (t) => {
  const f = await startAudioProcessingFixture(t);
  const input = {
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: 100,
    durationSeconds: 10,
    sha256: Buffer.alloc(32).toString('base64'),
  };
  const createClaim = async () => {
    const created = await f.request('POST', '/jobs', {
      requestId: randomUUID(),
      input,
    });
    f.fakeStorage.put(
      (await f.jobs.findById(created.body.id)).inputReservation,
    );
    await f.request('POST', `/jobs/${created.body.id}/upload-complete`, {});
    const claim = await f.request(
      'POST',
      '/worker/claim',
      { sessionId: randomUUID() },
      'worker',
    );
    assert.equal(claim.status, 200);
    const { jobId, attemptId, sessionId, generation } = claim.body;
    return { jobId, attemptId, sessionId, generation };
  };
  const first = await createClaim();
  const cancelled = await f.request('POST', `/jobs/${first.jobId}/cancel`, {});
  assert.equal(cancelled.body.status, 'cancel_requested');
  assert.equal(
    (await f.control.findById('z440')).activeJobId.toString(),
    first.jobId,
  );
  assert.equal(
    (await f.request('POST', '/worker/heartbeat', first, 'worker')).body
      .cancelRequested,
    true,
  );
  assert.equal(
    (
      await f.request(
        'POST',
        '/worker/cancelled',
        { ...first, eventId: randomUUID(), stopped: false },
        'worker',
      )
    ).status,
    400,
  );
  const failure = {
    ...first,
    eventId: randomUUID(),
    stopped: true,
    code: 'SEPARATOR_FAILED',
    stage: 'validating',
    exitCode: 1,
  };
  assert.equal(
    (
      await f.request(
        'POST',
        '/worker/fail',
        { ...failure, message: 'private raw error' },
        'worker',
      )
    ).status,
    400,
  );
  const stopped = await f.request('POST', '/worker/fail', failure, 'worker');
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.status, 'cancelled');
  assert.equal((await f.control.findById('z440')).activeJobId, null);
  assert.equal(await f.errors.countDocuments(), 1);
  assert.equal(await f.jobs.db.model('NotificationOutbox').countDocuments(), 0);
  assert.equal(
    (await f.request('POST', '/worker/fail', failure, 'worker')).body.status,
    'cancelled',
  );
  assert.equal(await f.errors.countDocuments(), 1);
  const second = await createClaim();
  const secondFailure = {
    ...second,
    eventId: randomUUID(),
    stopped: true,
    code: 'SEPARATOR_FAILED',
    stage: 'validating',
  };
  assert.equal(
    (await f.request('POST', '/worker/fail', secondFailure, 'worker')).body
      .status,
    'failed',
  );
  const detail = await f.request('GET', `/jobs/${second.jobId}`);
  assert.equal(detail.body.error.code, 'SEPARATOR_FAILED');
  assert.doesNotMatch(
    JSON.stringify(detail.body),
    /exitCode|generation|attemptId|sessionId/,
  );
  const retryRequest = { requestId: randomUUID() };
  const retry = await f.request(
    'POST',
    `/jobs/${second.jobId}/retry`,
    retryRequest,
  );
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  assert.notEqual(retry.body.id, second.jobId);
  assert.equal(retry.body.status, 'queued');
  assert.equal(
    (await f.request('POST', `/jobs/${second.jobId}/retry`, retryRequest)).body
      .id,
    retry.body.id,
  );
});
