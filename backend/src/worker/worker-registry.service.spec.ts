import { model } from 'mongoose';
import { WorkerRegistrationSchema } from './worker-registration.schema.js';
import { JobAttemptSchema } from '../jobs/job-attempt.schema.js';

const Registration = model(
  'WorkerRegistrationBoundaryFixture',
  WorkerRegistrationSchema,
);
const Attempt = model('OwnedAttemptBoundaryFixture', JobAttemptSchema);

describe('worker registry persistence boundary', () => {
  it('requires bounded identity, label, digest and lifecycle state', () => {
    expect(
      new Registration({
        installationId: '11111111-1111-4111-8111-111111111111',
        _id: 'machine-2',
        label: 'Machine 2',
        keySha256: 'a'.repeat(64),
        state: 'enabled',
      }).validateSync(),
    ).toBeUndefined();
    const invalid = new Registration({
      _id: '../machine',
      label: '',
      keySha256: 'not-a-digest',
      state: 'unknown',
    });
    expect(Object.keys(invalid.validateSync()!.errors).sort()).toEqual([
      '_id',
      'installationId',
      'keySha256',
      'label',
      'state',
    ]);
  });
  it('requires an explicit owner for newly written attempts without inventing historical owners', () => {
    expect(new Attempt({}).validateSync()?.errors).toHaveProperty('workerId');
    expect(Attempt.hydrate({}).workerId).toBeUndefined();
  });
});
