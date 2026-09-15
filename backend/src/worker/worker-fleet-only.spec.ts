import { ConfigService } from '@nestjs/config';
import { WorkerRegistryService } from './worker-registry.service.js';

describe('fleet-only worker authority', () => {
  const registry = new WorkerRegistryService(
    {} as never,
    {} as never,
    new ConfigService(),
  );
  it('never invents an identity without a registered caller', () => {
    expect(() => registry.context()).toThrow();
  });
  it.each([undefined, null, '', '../worker'])(
    'rejects missing or invalid ownership %s',
    (owner) => {
      expect(() => registry.ownerId(owner)).toThrow();
    },
  );
});
