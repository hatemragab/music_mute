import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import helmet from 'helmet';
import { PUBLIC_ROUTE } from '../auth/auth.decorators.js';
import { PUBLIC_POLICY_DEFAULTS } from '../config/public-policy.js';
import { PublicPagesController } from './public-pages.controller.js';
import { PublicPagesModule } from './public-pages.module.js';

const configured: Record<string, string> = {
  PUBLIC_SITE_ORIGIN: 'https://policy.example.test',
  PUBLIC_SUPPORT_EMAIL: 'support@example.test',
  PUBLIC_DEVELOPER_NAME: 'Example Developer',
  PUBLIC_DELETION_TIMEFRAME: 'The verified test policy timeframe.',
  PUBLIC_RETENTION_NOTICE: 'The verified test backup retention policy.',
};

describe('Public account, privacy, and support resources', () => {
  let app: INestApplication;
  let values: Record<string, string>;

  beforeEach(async () => {
    values = { ...configured };
    const module = await Test.createTestingModule({
      imports: [PublicPagesModule],
    })
      .overrideProvider(ConfigService)
      .useValue({ get: (key: string) => values[key] })
      .compile();
    app = module.createNestApplication();
    app.use(helmet());
    await app.init();
  });

  afterEach(async () => app.close());

  it('serves an actionable deletion request without the app or bearer', async () => {
    const response = await request(app.getHttpServer())
      .get('/delete-account')
      .expect(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store, no-transform');
    expect(response.text).toContain('MusicMute');
    expect(response.text).toContain('Example Developer');
    expect(response.text).toContain('mailto:support@example.test?subject=');
    expect(response.text).toContain('ownership-verification');
    expect(response.text).toContain('exact 15-day recovery period');
    expect(response.text).toContain('without reinstalling or opening the app');
    expect(response.text).toContain(configured.PUBLIC_DELETION_TIMEFRAME);
    expect(response.text).toContain(configured.PUBLIC_RETENTION_NOTICE);
    expect(response.text).toContain('href="/privacy"');
    expect(response.text).toContain('href="/support"');
    expect(response.text).not.toContain('<form');
    expect(response.text).not.toContain('<script');
    expect(Reflect.getMetadata(PUBLIC_ROUTE, PublicPagesController)).toBe(true);
  });

  it('uses repository-owned defaults when publication overrides are absent', async () => {
    values = {};
    for (const path of ['/delete-account', '/privacy', '/support']) {
      const response = await request(app.getHttpServer()).get(path).expect(200);
      expect(response.headers['cache-control']).toBe('no-store, no-transform');
      expect(response.text).toContain(PUBLIC_POLICY_DEFAULTS.developerName);
      expect(response.text).toContain(PUBLIC_POLICY_DEFAULTS.supportEmail);
    }
    const metadata = await request(app.getHttpServer())
      .get('/public-policy')
      .expect(200);
    expect(metadata.body).toMatchObject({
      policy_version: PUBLIC_POLICY_DEFAULTS.policyVersion,
      support_email: PUBLIC_POLICY_DEFAULTS.supportEmail,
      urls: {
        privacy: 'https://api.music-mute.com/privacy',
        account_deletion: 'https://api.music-mute.com/delete-account',
        support: 'https://api.music-mute.com/support',
      },
    });
  });

  it.each([
    ['PUBLIC_SUPPORT_EMAIL', 'unsafe\r\nBcc:recipient@example.test'],
    ['PUBLIC_SUPPORT_EMAIL', 'person@example.test?subject=inject'],
    ['PUBLIC_SUPPORT_EMAIL', 'not-an-address'],
    ['PUBLIC_SITE_ORIGIN', 'https://policy.example.test/privacy'],
    ['PUBLIC_DEVELOPER_NAME', ''],
    ['PUBLIC_DELETION_TIMEFRAME', '\u0000unsafe'],
    ['PUBLIC_RETENTION_NOTICE', 'x'.repeat(4001)],
  ])('fails closed for unsafe %s configuration', async (key, value) => {
    values[key] = value;
    const response = await request(app.getHttpServer())
      .get('/delete-account')
      .expect(503);
    if (value) expect(response.text).not.toContain(value);
  });

  it('escapes configured display text instead of trusting markup', async () => {
    values.PUBLIC_DEVELOPER_NAME = '<img src=x onerror="alert(1)">';
    values.PUBLIC_DELETION_TIMEFRAME = '</p><script>bad()</script>';
    values.PUBLIC_RETENTION_NOTICE = 'A & B < backup';
    const response = await request(app.getHttpServer())
      .get('/delete-account')
      .expect(200);
    expect(response.text).toContain('&lt;img');
    expect(response.text).toContain('&lt;script&gt;');
    expect(response.text).toContain('A &amp; B &lt; backup');
    expect(response.text).not.toContain('<img');
    expect(response.text).not.toContain('<script');
  });

  it('ignores supplied identities and never exposes a public deletion mutation', async () => {
    const response = await request(app.getHttpServer())
      .get('/delete-account?email=private@example.test&token=secret-token')
      .expect(200);
    expect(response.text).not.toContain('private@example.test');
    expect(response.text).not.toContain('secret-token');
    await request(app.getHttpServer())
      .post('/delete-account')
      .send({ email: 'private@example.test' })
      .expect(404);
    await request(app.getHttpServer()).delete('/delete-account').expect(404);
  });

  it('discloses the current collection, processing, provider, and deletion behavior', async () => {
    const response = await request(app.getHttpServer())
      .get('/privacy')
      .expect(200);
    for (const value of [
      'Firebase',
      'MongoDB',
      'S3-compatible storage',
      'Sentry',
      'IP address',
      'audio-only stream',
      'voice-only results',
      '15-day recovery period',
      'does not sell personal information',
    ]) {
      expect(response.text).toContain(value);
    }
    expect(response.text).toContain('href="/delete-account"');
    expect(response.text).not.toContain('temporarily unavailable');
    expect(response.text).not.toContain('three-calendar-month');
    expect(response.text).not.toMatch(/https?:\/\/[^\s"<]+/);
    expect(response.headers['content-security-policy']).toContain(
      "script-src 'none'",
    );
  });

  it('serves a privacy-safe support destination', async () => {
    const response = await request(app.getHttpServer())
      .get('/support')
      .expect(200);
    expect(response.text).toContain('MusicMute%20support%20request');
    expect(response.text).toContain('mailto:support@example.test?subject=');
    expect(response.text).toContain('Do not send passwords');
    expect(response.text).toContain('href="/delete-account"');
    expect(response.text).toContain('href="/privacy"');
  });

  it('publishes bounded machine-readable policy metadata', async () => {
    const response = await request(app.getHttpServer())
      .get('/public-policy')
      .expect(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      schema_version: 1,
      policy_version: PUBLIC_POLICY_DEFAULTS.policyVersion,
      updated_at: PUBLIC_POLICY_DEFAULTS.policyUpdatedAt,
      app_name: 'MusicMute',
      developer_name: 'Example Developer',
      support_email: 'support@example.test',
      urls: {
        privacy: 'https://policy.example.test/privacy',
        account_deletion: 'https://policy.example.test/delete-account',
        support: 'https://policy.example.test/support',
      },
      account_deletion: {
        available_in_app: true,
        external_request_available: true,
        recovery_period_days: 15,
        replay_fence_hours: 24,
      },
    });
  });
});
