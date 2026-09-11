import {
  Body,
  Controller,
  Get,
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

@Controller('users/me/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}
  @Get()
  async list(@Req() req: AuthRequest, @Query() query: ListDevicesDto) {
    const page = await this.devices.listOwned(
      req.user!._id.toHexString(),
      query,
    );
    return {
      items: page.items.map(presentDevice),
      nextCursor: page.nextCursor,
    };
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
