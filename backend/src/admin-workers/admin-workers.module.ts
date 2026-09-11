import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module.js';
import { AudioProcessingModule } from '../processing/processing.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { AdminWorkersService } from './admin-workers.service.js';
import { AdminWorkersController } from './admin-workers.controller.js';
@Module({
  imports: [AdminModule, AudioProcessingModule, ProcessingPersistenceModule],
  providers: [AdminWorkersService],
  controllers: [AdminWorkersController],
})
export class AdminWorkersModule {}
