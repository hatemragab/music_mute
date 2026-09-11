import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startAudioProcessingFixture } from './helpers/audio-processing-fixture.mjs';

test('voice result completion is durable and recovery adopts an uploaded result', async (t) => {
  const f = await startAudioProcessingFixture(t);
  const input = {
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: 100,
    durationSeconds: 10,
    sha256: Buffer.alloc(32).toString('base64'),
  };
  const reserve = async () => {
    const created = await f.request('POST', '/jobs', {
      requestId: randomUUID(),
      input,
    });
    assert.equal(created.status, 201);
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
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    const { jobId, attemptId, sessionId, generation } = claim.body;
    const selector = { jobId, attemptId, sessionId, generation };
    const stage = await f.request(
      'POST',
      '/worker/stage',
      {
        ...selector,
        eventId: randomUUID(),
        stage: 'processing',
        durationSeconds: 10,
        decodable: true,
        hasAudio: true,
      },
      'worker',
    );
    assert.equal(stage.status, 200);
    const declaration = {
      ...selector,
      eventId: randomUUID(),
      bytes: 90,
      durationSeconds: 10,
      sha256: input.sha256,
      contentType: 'audio/mpeg',
      playable: true,
      voiceOnly: true,
    };
    const output = await f.request(
      'POST',
      '/worker/output-url',
      declaration,
      'worker',
    );
    assert.equal(output.status, 200, JSON.stringify(output.body));
    assert.equal(output.headers['cache-control'], 'no-store');
    assert.equal(
      (await f.request('POST', '/worker/output-url', declaration, 'worker'))
        .status,
      200,
    );
    assert.equal(
      (
        await f.request(
          'POST',
          '/worker/output-url',
          { ...declaration, bytes: 91 },
          'worker',
        )
      ).status,
      409,
    );
    f.fakeStorage.put((await f.jobs.findById(jobId)).outputReservation);
    return selector;
  };
  const first = await reserve();
  const callback = { ...first, eventId: randomUUID() };
  const outboxCollection = f.jobs.db.model('NotificationOutbox').collection;
  const insert = outboxCollection.insertOne;
  outboxCollection.insertOne = async () => {
    throw new Error('simulated durable outbox write failure');
  };
  try {
    assert.equal(
      (await f.request('POST', '/worker/complete', callback, 'worker')).status,
      500,
    );
    assert.equal(
      (await f.jobs.findById(first.jobId)).status,
      'uploading_result',
    );
    assert.equal(
      (await f.control.findById('z440')).activeJobId.toString(),
      first.jobId,
    );
    assert.equal(
      await f.receipts.countDocuments({ eventId: callback.eventId }),
      0,
    );
    assert.equal(
      (await f.attempts.findOne({ attemptId: first.attemptId })).endedAt,
      null,
    );
  } finally {
    outboxCollection.insertOne = insert;
  }
  const completed = await f.request(
    'POST',
    '/worker/complete',
    callback,
    'worker',
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.status, 'ready');
  const outbox = f.jobs.db.model('NotificationOutbox');
  assert.equal(await outbox.countDocuments(), 1);
  assert.equal((await f.control.findById('z440')).activeJobId, null);
  await f.restartApi();
  assert.equal(
    (await f.request('POST', '/worker/complete', callback, 'worker')).body
      .status,
    'ready',
  );
  assert.equal(await f.jobs.db.model('NotificationOutbox').countDocuments(), 1);
  const second = await reserve();
  await f.jobs.updateOne(
    { _id: second.jobId },
    { $set: { leaseExpiresAt: new Date(0) } },
  );
  await f.control.updateOne(
    { _id: 'z440' },
    { $set: { leaseExpiresAt: new Date(0) } },
  );
  f.fakeStorage.failNext('findOutput');
  const recovery = {
    sessionId: randomUUID(),
    previousAttemptId: second.attemptId,
    stopped: true,
  };
  assert.equal(
    (await f.request('POST', '/worker/reconcile', recovery, 'worker')).status,
    503,
  );
  assert.equal(
    (await f.control.findById('z440')).activeJobId.toString(),
    second.jobId,
  );
  const recovered = await f.request(
    'POST',
    '/worker/reconcile',
    recovery,
    'worker',
  );
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.status, 'ready');
  assert.equal(await f.attempts.countDocuments({ jobId: second.jobId }), 1);
  assert.equal(await f.jobs.db.model('NotificationOutbox').countDocuments(), 2);
  assert.equal(
    (await f.request('POST', '/worker/reconcile', recovery, 'worker')).body
      .status,
    'ready',
  );
});
