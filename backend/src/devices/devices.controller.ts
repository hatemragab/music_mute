import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { LimitOperation } from '../auth/auth.decorators.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { DeviceMetadataDto } from './dto/device-report.dto.js';
import { ListDevicesDto } from './dto/list-devices.dto.js';
import { DevicesService } from './devices.service.js';
import { presentDevice } from './devices.presenter.js';
import { authError } from '../auth/auth.errors.js';
import { EmptyBodyPipe } from '../auth/dto/empty-body.pipe.js';

@Controller('users/me/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}
  @Get()
  async list(@Req() req: AuthRequest, @Query() query: ListDevicesDto) {
    const page = await this.devices.listOwned(
      req.user!._id.toHexString(),
      query,
    );
    const statuses = await this.devices.sessionStatuses(
      req.user!._id.toHexString(),
      page.items,
      req.user!.sessionsRevokedAfterSec,
    );
    return {
      items: page.items.map((device, index) =>
        presentDevice(device, statuses[index]),
      ),
      nextCursor: page.nextCursor,
    };
  }
  @Delete(':installationId')
  @HttpCode(204)
  @LimitOperation('device')
  async hide(
    @Req() req: AuthRequest,
    @Param(
      'installationId',
      new ParseUUIDPipe({
        version: '4',
        exceptionFactory: () => authError('INVALID_INPUT'),
      }),
    )
    installationId: string,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    await this.devices.hideFromHistory(
      req.user!._id.toHexString(),
      installationId,
    );
  }
  @Put(':installationId')
  @LimitOperation('device')
  async sync(
    @Req() req: AuthRequest,
    @Param(
      'installationId',
      new ParseUUIDPipe({
        version: '4',
        exceptionFactory: () => authError('INVALID_INPUT'),
      }),
    )
    installationId: string,
    @Body() report: DeviceMetadataDto,
  ) {
    return presentDevice(
      await this.devices.sync(
        req.user!._id.toHexString(),
        req.identity.authTimeSec,
        { ...report, installationId: installationId.toLowerCase() },
      ),
    );
  }
}
