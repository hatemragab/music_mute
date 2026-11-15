import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

test(
  'policy uses revision CAS and live reads; missing storage never disables restrictions',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases();
      connection = await createConnection(mongoUri, {
        sanitizeFilter: true,
        bufferCommands: false,
      }).asPromise();
      const { AppPolicy, AppPolicySchema } =
        await import('../dist/app-policy/app-policy.schema.js');
      const { AppPolicyService } =
        await import('../dist/app-policy/app-policy.service.js');
      const model = connection.model(AppPolicy.name, AppPolicySchema);
      await model.init();
      const service = new AppPolicyService(model);
      const initial = await service.current();
      assert.equal(initial.requireVerifiedEmail, false);
      const writes = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          service.replace({ ...initial, requireVerifiedEmail: true }, 0),
        ),
      );
      assert.equal(
        writes.filter((item) => item.status === 'fulfilled').length,
        1,
      );
      assert.ok(
        writes
          .filter((item) => item.status === 'rejected')
          .every((item) => item.reason.status === 409),
      );
      const stored = await service.current();
      assert.equal(stored.requireVerifiedEmail, true);
      assert.equal(stored.revision, 1);
      const changed = await service.replace(
        { ...stored, requireVerifiedEmail: false },
        1,
      );
      assert.equal(changed.revision, 2);
      assert.equal((await service.current()).requireVerifiedEmail, false);
      await assert.rejects(
        service.replace(stored, 1),
        (error) => error.status === 409,
      );
      await model.collection.updateOne(
        { _id: 'global' },
        { $set: { unknownRestriction: true } },
      );
      await assert.rejects(service.current(), (error) => error.status === 503);
      await connection.close();
      await assert.rejects(service.current(), (error) => error.status === 503);
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);
