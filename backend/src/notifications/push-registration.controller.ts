import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { LimitOperation } from '../auth/auth.decorators.js';
import { authError } from '../auth/auth.errors.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { ProcessingEnabledGuard } from '../processing/processing-enabled.guard.js';
import {
  PushDeactivationDto,
  PushRegistrationDto,
} from './dto/push-registration.dto.js';
import type { PushInstallationDocument } from './push-installation.schema.js';
import { PushRegistrationsService } from './push-registration.service.js';

const installationIdPipe = new ParseUUIDPipe({
  version: '4',
  exceptionFactory: () => authError('INVALID_INPUT'),
});

@Controller('devices')
@UseGuards(ProcessingEnabledGuard)
export class PushRegistrationController {
  constructor(private readonly registrations: PushRegistrationsService) {}

  @Put(':installationId/push')
  @HttpCode(200)
  @LimitOperation('device')
  async register(
    @Req() req: AuthRequest,
    @Param('installationId', installationIdPipe) installationId: string,
    @Body() dto: PushRegistrationDto,
  ) {
    return this.present(
      await this.registrations.register(
        req.user!,
        installationId.toLowerCase(),
        dto.token,
        req.identity.authTimeSec,
      ),
    );
  }

  @Post(':installationId/push/deactivate')
  @HttpCode(204)
  @LimitOperation('device')
  async deactivate(
    @Req() req: AuthRequest,
    @Param('installationId', installationIdPipe) installationId: string,
    @Body() dto: PushDeactivationDto,
  ): Promise<void> {
    // Optional-only DTOs can otherwise validate an empty array after transformation.
    if (Array.isArray(dto)) throw authError('INVALID_INPUT');
    await this.registrations.deactivate(
      req.user!._id.toHexString(),
      installationId.toLowerCase(),
      dto?.expectedBindingRevision,
    );
  }

  private present(registration: PushInstallationDocument) {
    return {
      installationId: registration.installationId,
      active: registration.active,
      bindingRevision: registration.bindingRevision,
    };
  }
}
