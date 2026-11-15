import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  LimitAdmin,
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../../admin/admin.decorators.js';
import type { AuthRequest } from '../../auth/auth-request.js';
import {
  AdminWorkerListQueryDto,
  RequestWorkerBenchmarkDto,
  RequestWorkerDoctorDto,
  UpdateWorkerFleetPolicyDto,
} from './worker-control.dto.js';
import { WorkerControlService } from './worker-control.service.js';

@Controller('admin/worker-fleet')
export class AdminWorkerControlController {
  constructor(private readonly control: WorkerControlService) {}

  @Get('machines')
  @RequireAdminPermission('workers.read')
  @LimitAdmin('read')
  machines(
    @Req() request: AuthRequest,
    @Query() query: AdminWorkerListQueryDto,
  ) {
    return this.control.listMachines(request.adminActor!, query);
  }

  @Get('machines/:id')
  @RequireAdminPermission('workers.read')
  @LimitAdmin('read')
  machine(@Req() request: AuthRequest, @Param('id') id: string) {
    return this.control.machineDetail(request.adminActor!, id);
  }

  @Post('machines/:id/doctor')
  @RequireAdminPermission('workers.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  doctor(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() dto: RequestWorkerDoctorDto,
  ) {
    return this.control.requestDoctor(request.adminActor!, id, dto);
  }

  @Post('machines/:id/benchmark')
  @RequireAdminPermission('workers.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  benchmark(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() dto: RequestWorkerBenchmarkDto,
  ) {
    return this.control.requestBenchmark(request.adminActor!, id, dto);
  }

  @Get('machines/:id/diagnostics')
  @RequireAdminPermission('workers.logs.read')
  @LimitAdmin('read')
  diagnostics(@Req() request: AuthRequest, @Param('id') id: string) {
    return this.control.machineDiagnostics(request.adminActor!, id);
  }

  @Get('invitations')
  @RequireAdminPermission('workers.enroll')
  @LimitAdmin('read')
  invitations(@Req() request: AuthRequest) {
    return this.control.listInvitations(request.adminActor!);
  }

  @Get('policy')
  @RequireAdminPermission('workers.read')
  @LimitAdmin('read')
  policy(@Req() request: AuthRequest) {
    return this.control.policy(request.adminActor!);
  }

  @Put('policy')
  @RequireAdminPermission('workers.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  updatePolicy(
    @Req() request: AuthRequest,
    @Body() dto: UpdateWorkerFleetPolicyDto,
  ) {
    return this.control.updatePolicy(request.adminActor!, dto);
  }
}
