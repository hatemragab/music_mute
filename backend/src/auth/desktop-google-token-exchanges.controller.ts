import { Body, Controller, Header, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from './auth.decorators.js';
import { DesktopGoogleTokenExchangeDto } from './dto/desktop-google-token-exchange.dto.js';
import { DesktopGoogleTokenExchangeService } from './desktop-google-token-exchange.service.js';

@Controller('auth/desktop-google-token-exchanges')
export class DesktopGoogleTokenExchangesController {
  constructor(private readonly exchange: DesktopGoogleTokenExchangeService) {}

  @Public()
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  create(@Body() dto: DesktopGoogleTokenExchangeDto, @Req() request: Request) {
    return this.exchange.exchange(dto, request.ip ?? 'unknown');
  }
}
