import { ServiceUnavailableException } from '@nestjs/common';
import type { Connection } from 'mongoose';
import type { Redis } from 'ioredis';
import { HealthController } from './health.controller.js';

describe('dependency readiness', () => {
  const fixture = () => {
    const database = {
      readyState: 1,
      db: { command: vi.fn().mockResolvedValue({ ok: 1 }) },
    };
    const redis = { ping: vi.fn().mockResolvedValue('PONG') };
    const controller = new HealthController(
      database as unknown as Connection,
      redis as unknown as Redis,
    );
    return { database, redis, controller };
  };
  it('pings MongoDB and the shared Redis client', async () => {
    const { database, redis, controller } = fixture();
    await expect(controller.ready()).resolves.toEqual({ status: 'ok' });
    expect(database.db.command).toHaveBeenCalledWith(
      { ping: 1 },
      { timeoutMS: 2000 },
    );
    expect(redis.ping).toHaveBeenCalledOnce();
  });
  it('returns a sanitized error during Redis failure while liveness stays available', async () => {
    const { redis, controller } = fixture();
    redis.ping.mockRejectedValue(new Error('redis://private:secret@host'));
    await expect(controller.ready()).rejects.toThrow(
      new ServiceUnavailableException('Service unavailable'),
    );
    expect(controller.live()).toEqual({ status: 'ok' });
  });
  it('bounds readiness when Redis never responds', async () => {
    const { redis, controller } = fixture();
    redis.ping.mockImplementation(() => new Promise(() => {}));
    await expect(controller.ready()).rejects.toThrow('Service unavailable');
  }, 8000);
});
