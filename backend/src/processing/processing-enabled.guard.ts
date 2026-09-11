import {
  Injectable,
  ServiceUnavailableException,
  type CanActivate,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ProcessingEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(): boolean {
    if (!this.config.get<boolean>('AUDIO_PROCESSING_ENABLED')) {
      throw new ServiceUnavailableException({
        code: 'PROCESSING_UNAVAILABLE',
        message: 'Audio processing is unavailable',
      });
    }
    return true;
  }
}
