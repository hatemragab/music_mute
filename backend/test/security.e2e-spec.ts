import 'reflect-metadata';
import { Body, Controller, Get, Post } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { SkipThrottle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import request from 'supertest';
import { configureHttp } from '../src/http/configure-http.js';
import { SecurityModule } from '../src/http/security.module.js';
import { SECURITY_REDIS } from '../src/rate-limits/security-redis.provider.js';

class ProbeDto {
  @IsString()
  @MaxLength(20)
  value!: string;
}
// Test-only routes exercise policies without adding business API endpoints.
@Controller('probe')
class ProbeController {
  @Get() get() {
    return { ok: true };
  }
  @Get('alternate') alternate() {
    return { ok: true };
  }
  @SkipThrottle()
  @Get('live')
  live() {
    return { status: 'ok' };
  }
  @Get('failure') failure() {
    throw new Error('private-sdk-credential');
  }
  @Post() post(@Body() dto: ProbeDto) {
    return dto;
  }
}

describe('HTTP security defaults', () => {
  let app: NestExpressApplication;
  let redis: FakeRedis;
  beforeEach(async () => {
    redis = new FakeRedis();
    const builder = Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          skipProcessEnv: true,
          load: [
            () => ({
              APP_ENV: 'production',
              RATE_LIMIT: 3,
              RATE_TTL_MS: 60000,
              FIREBASE_PROJECT_ID: 'demo-musicmute',
              RATE_LIMIT_HASH_SECRET: '0123456789abcdef0123456789abcdef',
              BODY_LIMIT_BYTES: 1024,
              CORS_ORIGINS: 'https://allowed.test',
              TRUST_PROXY: 'false',
            }),
          ],
        }),
        SecurityModule,
      ],
      controllers: [ProbeController],
    });
    builder.overrideProvider(SECURITY_REDIS).useValue(redis);
    const module = await builder.compile();
    app = module.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureHttp(app);
    await app.init();
  });
  afterEach(async () => {
    if (app) await app.close();
  });
  it('sets security headers and removes framework disclosure', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/probe')
      .expect(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBeDefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
  it('allows only configured browser origins', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/api/v1/probe')
      .set('Origin', 'https://allowed.test');
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://allowed.test',
    );
    const blocked = await request(app.getHttpServer())
      .get('/api/v1/probe')
      .set('Origin', 'https://evil.test');
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('enforces rate limits despite forged forwarded IPs', async () => {
    for (const [index, route] of [
      '/api/v1/probe',
      '/api/v1/probe/alternate',
      '/api/v1/probe',
    ].entries())
      await request(app.getHttpServer())
        .get(route)
        .set('X-Forwarded-For', `192.0.2.${index}`)
        .expect(200);
    const response = await request(app.getHttpServer())
      .get('/api/v1/probe/alternate')
      .set('X-Forwarded-For', '192.0.2.99')
      .expect(429);
    expect(response.headers['retry-after']).toBeDefined();
    expect(response.body).toEqual({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: 'Too many requests',
    });
  });
  it('preserves explicit liveness throttle exemptions', async () => {
    for (let index = 0; index < 5; index++)
      await request(app.getHttpServer()).get('/api/v1/probe/live').expect(200);
  });
  it('fails closed without exposing Redis errors', async () => {
    redis.available = false;
    const response = await request(app.getHttpServer())
      .get('/api/v1/probe')
      .expect(503);
    expect(response.body).toEqual({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service unavailable',
    });
    expect(response.text).not.toContain('private-redis-endpoint');
  });
  it('validates DTOs and rejects unknown properties', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/probe')
      .send({ value: 'ok' })
      .expect(201, { value: 'ok' });
    await request(app.getHttpServer())
      .post('/api/v1/probe')
      .send({ value: 42 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/probe')
      .send({ value: 'ok', admin: true })
      .expect(400);
  });
  it('bounds JSON bodies and rejects malformed JSON', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/probe')
      .send({ value: 'a'.repeat(2000) })
      .expect(413);
    const malformed = await request(app.getHttpServer())
      .post('/api/v1/probe')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
    expect(malformed.body).toEqual({
      statusCode: 400,
      code: 'INVALID_INPUT',
      message: 'Invalid input',
    });
  });
  it('does not disclose internal exceptions', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/probe/failure')
      .expect(500);
    expect(response.body).toEqual({
      statusCode: 500,
      message: 'Service unavailable',
    });
    expect(response.text).not.toContain('private-sdk-credential');
  });
  it('rejects unsupported request encodings', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/probe')
      .set('Content-Type', 'application/json; charset=iso-8859-1')
      .send('{"value":"ok"}')
      .expect(415);
  });
});

class FakeRedis {
  readonly status = 'end';
  available = true;
  private readonly hits = new Map<string, number[]>();
  private readonly blocks = new Map<string, number>();

  async eval(
    _script: string,
    numberOfKeys: number,
    ...values: Array<string | number>
  ): Promise<number[]> {
    if (!this.available) throw new Error('private-redis-endpoint');
    if (numberOfKeys !== 2) throw new Error('Unexpected test script');
    const [hitsKey, blockKey] = values.map(String);
    const [ttl, limit, blockDuration] = values
      .slice(2, 5)
      .map((value) => Number(value));
    const now = Date.now();
    const blockedUntil = this.blocks.get(blockKey) ?? 0;
    if (blockedUntil > now) return [limit + 1, 0, 1, blockedUntil - now];
    const current = (this.hits.get(hitsKey) ?? []).filter(
      (timestamp) => timestamp > now - ttl,
    );
    current.push(now);
    if (current.length > limit) {
      this.hits.delete(hitsKey);
      this.blocks.set(blockKey, now + blockDuration);
      return [current.length, ttl, 1, blockDuration];
    }
    this.hits.set(hitsKey, current);
    return [current.length, current[0] + ttl - now, 0, 0];
  }

  disconnect(): void {}
}
