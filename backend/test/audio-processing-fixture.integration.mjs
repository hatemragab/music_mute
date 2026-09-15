import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { startAudioProcessingFixture } from './helpers/audio-processing-fixture.mjs';

const sessionReport = (installationId) => ({
  installationId,
  platform: 'ios',
  appVersion: '1.0.0',
  buildNumber: 1,
  metadataRevision: 1,
  osVersion: '26.0',
  deviceModel: 'Audio processing fixture',
});

test(
  'compiled audio fixture authenticates isolated users and preserves state across API restart',
  { timeout: 120000 },
  async (t) => {
    const fixture = await startAudioProcessingFixture(t);
    const owner = await fixture.request(
      'POST',
      '/auth/session',
      sessionReport(fixture.installationId),
    );
    const other = await fixture.request(
      'POST',
      '/auth/session',
      sessionReport(randomUUID()),
      'other',
    );
    const anonymous = await fixture.request(
      'POST',
      '/auth/session',
      sessionReport(randomUUID()),
      'anonymous',
    );

    assert.equal(owner.status, 200);
    assert.equal(other.status, 200);
    assert.equal(anonymous.status, 401);
    assert.notEqual(owner.body.user.id, other.body.user.id);
    assert.equal(owner.body.user.emailVerified, true);
    assert.equal(other.body.user.emailVerified, true);
    assert.equal(owner.body.access.allowed, true);
    assert.equal(other.body.access.allowed, true);
    assert.equal(owner.body.device.installationId, fixture.installationId);
    const history = await fixture.request('GET', '/jobs');
    assert.equal(history.status, 200);
    assert.deepEqual(history.body, { items: [], nextCursor: null });
    assert.match(history.headers['cache-control'], /\bno-store\b/);
    assert.equal(await fixture.jobs.countDocuments(), 0);
    assert.equal(await fixture.attempts.countDocuments(), 0);
    assert.equal(await fixture.errors.countDocuments(), 0);
    assert.equal(await fixture.receipts.countDocuments(), 0);
    assert.equal(await fixture.control.countDocuments(), 1);
    assert.ok(fixture.fakeStorage.objects instanceof Map);

    await fixture.restartApi();
    const restartedOwner = await fixture.request(
      'POST',
      '/auth/session',
      sessionReport(fixture.installationId),
    );
    assert.equal(restartedOwner.status, 200);
    assert.equal(restartedOwner.body.user.id, owner.body.user.id);
  },
);
