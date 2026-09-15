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
      ...(await this.registry.describeInstallation(identity)),
      protocolVersion: 3 as const,
      mediaPolicyVersion: 2 as const,
      updateCapability: {
        supported: false,
        reasonCode: 'UPDATE_SERVICE_UNAVAILABLE',
      },
    };
  }
}
