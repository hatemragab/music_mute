import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.decorators.js';
import { AppPolicyService } from './app-policy.service.js';
import { presentPolicy } from './app-policy.presenter.js';

@Controller('app-policy')
export class AppPolicyController {
  constructor(private readonly policies: AppPolicyService) {}
  @Public()
  @Get()
  async current() {
    return presentPolicy(await this.policies.current());
  }
}
