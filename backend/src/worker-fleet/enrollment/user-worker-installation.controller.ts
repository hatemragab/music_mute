import { Body, Controller, Header, Post, Req } from '@nestjs/common';
import { LimitOperation } from '../../auth/auth.decorators.js';
import type { AuthRequest } from '../../auth/auth-request.js';
import { EmptyBodyPipe } from '../../auth/dto/empty-body.pipe.js';
import { WorkerEnrollmentService } from './worker-enrollment.service.js';

@Controller('users/me/worker-installation')
export class UserWorkerInstallationController {
  constructor(private readonly enrollment: WorkerEnrollmentService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @LimitOperation('worker-installation')
  workerInstallation(
    @Req() req: AuthRequest,
    @Body(EmptyBodyPipe) _body: void,
  ) {
    return this.enrollment.createUserInvitation(
      req.user!._id.toHexString(),
      req.identity,
    );
  }
}
