import { describe, expect, it } from 'vitest';
import {
  AbuseEventBucketSchema,
  AbuseMonthlySummarySchema,
} from './abuse-event.schema.js';
import { AccountRestrictionSchema } from './account-restriction.schema.js';

const names = (schema: { indexes(): Array<[unknown, { name?: string }]> }) =>
  schema.indexes().map(([, options]) => options.name);

describe('bounded abuse protection persistence', () => {
  it('keeps only the required event lookup and TTL indexes', () => {
    expect(names(AbuseEventBucketSchema)).toEqual([
      'abuse_event_bucket_unique',
      'abuse_event_account_page',
      'abuse_event_recent_page',
      'abuse_event_admin_filter',
      'abuse_event_severity_filter',
      'abuse_event_expiry',
    ]);
    expect(names(AbuseMonthlySummarySchema)).toEqual([
      'abuse_summary_unique',
      'abuse_summary_expiry',
    ]);
    expect(
      AbuseEventBucketSchema.indexes().find(
        ([, options]) => options.name === 'abuse_event_expiry',
      )?.[1],
    ).toMatchObject({ expireAfterSeconds: 0 });
  });

  it('uses one account restriction record with bounded admin indexes', () => {
    expect(names(AccountRestrictionSchema)).toEqual([
      'account_restriction_lookup',
      'account_restriction_admin_page',
    ]);
    expect(
      AccountRestrictionSchema.indexes().find(
        ([, options]) => options.name === 'account_restriction_lookup',
      )?.[1],
    ).toMatchObject({ unique: true });
    expect(AccountRestrictionSchema.get('strict')).toBe('throw');
  });
});
