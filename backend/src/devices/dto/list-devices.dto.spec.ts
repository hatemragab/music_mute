import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListDevicesDto } from './list-devices.dto.js';

const before = '64b64c9f4f1a2b3c4d5e6f70';
const errors = (value: object) =>
  validate(plainToInstance(ListDevicesDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('device list query boundary', () => {
  it('accepts the documented before cursor and maximum page size', async () => {
    expect(await errors({ before, limit: 50 })).toEqual([]);
  });

  it('rejects a page size above 50', async () => {
    expect((await errors({ limit: 51 })).length).toBeGreaterThan(0);
  });

  it('rejects the undocumented cursor query key', async () => {
    expect((await errors({ cursor: before }))[0]?.property).toBe('cursor');
  });
});
