import { UserSchema } from './user.schema.js';

describe('UserSchema indexes', () => {
  it('uses a distinct name for the recovery-aware deletion schedule', () => {
    const indexes = UserSchema.indexes();
    const deletionSchedule = indexes.find(
      ([, options]) => options.name === 'users_deletion_recovery_due',
    );

    expect(deletionSchedule?.[0]).toEqual({
      status: 1,
      deletionRecoverUntil: 1,
      deletionNextAt: 1,
    });
    expect(indexes.map(([, options]) => options.name)).not.toContain(
      'users_deletion_due',
    );
  });
});
