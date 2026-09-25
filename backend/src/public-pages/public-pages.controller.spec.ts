import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import helmet from 'helmet';
import { PUBLIC_ROUTE } from '../auth/auth.decorators.js';
import { PublicPagesController } from './public-pages.controller.js';
import { PublicPagesModule } from './public-pages.module.js';

const configured: Record<string, string> = {
  PUBLIC_SUPPORT_EMAIL: 'support@example.test',
  PUBLIC_DEVELOPER_NAME: 'Example Developer',
  PUBLIC_DELETION_TIMEFRAME: 'The verified test policy timeframe.',
  PUBLIC_RETENTION_NOTICE: 'The verified test backup retention policy.',
};

describe('Public account deletion and privacy pages', () => {
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

  it('serves an actionable public email request without the app or bearer', async () => {
    const response = await request(app.getHttpServer())
      .get('/delete-account')
      .expect(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).toContain('MusicMute');
    expect(response.text).toContain('Example Developer');
    expect(response.text).toContain('mailto:support@example.test?subject=');
    expect(response.text).toContain('ownership');
    expect(response.text).toContain('exactly 15 days');
    expect(response.text).toContain('starts a 15-day recovery period');
    expect(response.text).not.toContain('three-calendar-month');
    expect(response.text).toContain('without reinstalling');
    expect(response.text).toContain(configured.PUBLIC_DELETION_TIMEFRAME);
    expect(response.text).toContain(configured.PUBLIC_RETENTION_NOTICE);
    expect(response.text).toContain('href="/privacy"');
    expect(response.text).not.toContain('<form');
    expect(response.text).not.toContain('<script');
    expect(Reflect.getMetadata(PUBLIC_ROUTE, PublicPagesController)).toBe(true);
  });

  it.each(Object.keys(configured))(
    'fails closed when %s is absent',
    async (key) => {
      delete values[key];
      await request(app.getHttpServer()).get('/delete-account').expect(503);
      await request(app.getHttpServer()).get('/privacy').expect(503);
    },
  );

  it.each([
    'unsafe\r\nBcc:recipient@example.test',
    'person@example.test?subject=inject',
    'not-an-address',
  ])('rejects unsafe email configuration: %s', async (email) => {
    values.PUBLIC_SUPPORT_EMAIL = email;
    const response = await request(app.getHttpServer())
      .get('/delete-account')
      .expect(503);
    expect(response.text).not.toContain(email);
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

  it('ignores supplied identities and never creates a public deletion mutation', async () => {
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

  it('discloses cloud, authentication, temporary processing availability and server-side link imports', async () => {
    const response = await request(app.getHttpServer())
      .get('/privacy')
      .expect(200);
    for (const value of [
      'Firebase',
      'MongoDB',
      'S3',
      'temporarily unavailable',
      '24 hours',
      'audio-only stream',
      'vocals-only',
      'logs',
    ]) {
      expect(response.text).toContain(value);
    }
    expect(response.text).toContain('href="/delete-account"');
    expect(response.text).toContain('15-day account-deletion recovery period');
    expect(response.text).not.toContain('three-calendar-month');
    expect(response.text).not.toMatch(/https?:\/\/[^\s"<]+/);
    expect(response.headers['content-security-policy']).toContain(
      "script-src 'none'",
    );
  });
});
