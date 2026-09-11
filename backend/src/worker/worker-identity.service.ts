import { Injectable } from '@nestjs/common';
import { WorkerRegistryService } from './worker-registry.service.js';
import type { WorkerIdentity } from './worker-routes.js';

@Injectable()
export class WorkerIdentityService {
  constructor(private readonly registry: WorkerRegistryService) {}

  authenticateDigest(keySha256: string): Promise<WorkerIdentity> {
    return this.registry.authenticateDigest(keySha256);
  }

  async describe(identity: WorkerIdentity) {
    return {
      workerId: identity.workerId,
      state: await this.registry.state(identity),
      protocolVersion: 2 as const,
    };
  }
}
