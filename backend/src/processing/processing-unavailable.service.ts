import { Injectable } from '@nestjs/common';
import { jobError } from '../jobs/job-errors.js';

@Injectable()
export class ProcessingUnavailableService {
  reject(): never {
    // TODO(worker-redesign): Replace this boundary with the approved executor.
    throw jobError('PROCESSING_UNAVAILABLE');
  }
}
