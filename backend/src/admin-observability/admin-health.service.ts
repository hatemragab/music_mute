import { Injectable } from '@nestjs/common';
import { HealthSamplerService } from './health-sampler.service.js';

@Injectable()
export class AdminHealthService {
  constructor(private readonly sampler: HealthSamplerService) {}

  read() {
    return this.sampler.sample();
  }
}
