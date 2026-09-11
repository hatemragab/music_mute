import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  PushDeactivationDto,
  PushRegistrationDto,
} from './push-registration.dto.js';

const errors = (value: object) =>
  validate(plainToInstance(PushRegistrationDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('push registration input boundary', () => {
  it('accepts a bounded opaque FCM token', async () => {
    expect(await errors({ token: 'fixture-token:abc_123-XYZ' })).toEqual([]);
  });

  it.each([
    { token: '' },
    { token: 'contains whitespace' },
    { token: 'line\nbreak' },
    { token: '🎵' },
    { token: 'a'.repeat(4097) },
    { token: 123 },
    { token: 'fixture-token', userId: 'forged' },
    { token: 'fixture-token', active: true },
  ])('rejects invalid or server-owned fields %j', async (invalid) => {
    expect((await errors(invalid)).length).toBeGreaterThan(0);
  });

  it.each([
    {},
    { expectedBindingRevision: 1 },
    { expectedBindingRevision: Number.MAX_SAFE_INTEGER },
  ])('accepts a legacy body or a positive safe revision %j', async (body) => {
    expect(
      await validate(plainToInstance(PushDeactivationDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).toEqual([]);
  });

  it.each([
    { expectedBindingRevision: null },
    { expectedBindingRevision: 0 },
    { expectedBindingRevision: -1 },
    { expectedBindingRevision: 1.5 },
    { expectedBindingRevision: '1' },
    { expectedBindingRevision: true },
    { expectedBindingRevision: Number.MAX_SAFE_INTEGER + 1 },
    { expectedBindingRevision: Number.NaN },
    { expectedBindingRevision: Number.POSITIVE_INFINITY },
    { expectedBindingRevision: 1, active: false },
    { active: false },
  ])(
    'rejects invalid revisions and unknown opt-out fields %j',
    async (body) => {
      expect(
        (
          await validate(plainToInstance(PushDeactivationDto, body), {
            whitelist: true,
            forbidNonWhitelisted: true,
          })
        ).length,
      ).toBeGreaterThan(0);
    },
  );
});
