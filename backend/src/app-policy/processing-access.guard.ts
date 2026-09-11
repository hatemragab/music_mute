import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUUID } from 'class-validator';
import { PROCESSING_ACCESS } from '../auth/auth.decorators.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { authError } from '../auth/auth.errors.js';
import { DevicesService } from '../devices/devices.service.js';
import { AppPolicyService } from './app-policy.service.js';
import { evaluateProcessingAccess } from './access-policy.js';

@Injectable()
export class ProcessingAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly devices: DevicesService,
    private readonly policies: AppPolicyService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      !this.reflector.getAllAndOverride<boolean>(PROCESSING_ACCESS, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (!req.identity || !req.user) throw authError('UNAUTHENTICATED');
    const installationId = req.headers['x-installation-id'];
    if (typeof installationId !== 'string' || !isUUID(installationId, '4'))
      throw authError('DEVICE_SYNC_REQUIRED');
    const device = await this.devices.findOwned(
      req.user._id.toHexString(),
      installationId,
    );
    const policy = await this.policies.current();
    const decision = evaluateProcessingAccess(
      policy,
      req.identity.tokenEmailVerified,
      device,
    );
    if (!decision.allowed) throw authError(decision.reason);
    if (!device) throw authError('DEVICE_SYNC_REQUIRED');
    await this.policies.assertProcessingTargetAvailable(
      policy,
      device.platform,
    );
    return true;
  }
}
