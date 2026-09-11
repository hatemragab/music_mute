import { ConfigService } from '@nestjs/config';
import { databaseOptions } from './database.module.js';

describe('databaseOptions', () => {
  it('enables Mongoose schema collection and index creation in production', () => {
    const options = databaseOptions(
      new ConfigService({
        APP_ENV: 'production',
        MONGODB_URI:
          'mongodb+srv://user:password@example.mongodb.net/musicmute',
      }),
    );

    expect(options.autoCreate).toBe(true);
    expect(options.autoIndex).toBe(true);
  });

  it('allows read-only operator connections to disable automatic indexes', () => {
    const options = databaseOptions(
      new ConfigService({
        APP_ENV: 'production',
        MONGODB_URI:
          'mongodb+srv://user:password@example.mongodb.net/musicmute',
      }),
      false,
    );

    expect(options.autoCreate).toBe(false);
    expect(options.autoIndex).toBe(false);
  });
});
