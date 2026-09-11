import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  AllowUnprovisioned,
  LimitOperation,
  Public,
} from './auth.decorators.js';
import type { AuthRequest } from './auth-request.js';
import { AuthService } from './auth.service.js';
import { AuthMailService } from './auth-mail.service.js';
import { LogoutService } from './logout.service.js';
import { SessionDto } from './dto/session.dto.js';
import { PasswordResetDto } from './dto/password-reset.dto.js';
import { EmptyBodyPipe } from './dto/empty-body.pipe.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mail: AuthMailService,
    private readonly logout: LogoutService,
  ) {}

  @Post('session')
  @HttpCode(200)
  @AllowUnprovisioned()
  @LimitOperation('profile')
  session(@Req() req: AuthRequest, @Body() report: SessionDto) {
    return this.auth.bootstrap(req.identity, report);
  }

  @Post('profile-sync')
  @HttpCode(200)
  @LimitOperation('profile')
  profile(@Req() req: AuthRequest, @Body(EmptyBodyPipe) _body: unknown) {
    return this.auth.syncProfile(req.user!._id.toHexString(), req.identity);
  }

  @Post('verification-email')
  @HttpCode(202)
  async verification(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) response: Response,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    const result = await this.mail.requestVerification({
      identity: req.identity,
      bearer: req.bearer,
      ip: req.ip ?? '',
    });
    if (result.alreadyVerified) {
      response.status(200);
      return { status: 'already_verified' };
    }
    return { status: 'accepted' };
  }

  @Public()
  @Post('password-reset')
  @HttpCode(202)
  async passwordReset(@Req() req: AuthRequest, @Body() dto: PasswordResetDto) {
    await this.mail.requestPasswordReset(dto.email, req.ip ?? '');
    return { status: 'accepted' };
  }

  @Post('logout-all')
  @HttpCode(204)
  @LimitOperation('logout')
  async logoutAll(
    @Req() req: AuthRequest,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    await this.logout.logoutAll(req.user!._id.toHexString(), req.identity.uid);
  }
}
