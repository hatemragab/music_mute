import { PushInstallationSchema } from './push-installation.schema.js';

describe('inactive push registration retention', () => {
  it('protects active bindings with a partial expiry index', () => {
    expect(PushInstallationSchema.indexes()).toContainEqual([
      { purgeAt: 1 },
      {
        expireAfterSeconds: 0,
        partialFilterExpression: { active: false },
        name: 'push_inactive_registration_retention',
      },
    ]);
    expect(PushInstallationSchema.path('purgeAt').options.default).toBe(null);
  });
});
