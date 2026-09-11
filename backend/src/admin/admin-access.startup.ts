import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AdminAccess } from './admin-access.schema.js';

@Injectable()
export class AdminAccessStartup implements OnModuleInit {
  constructor(
    @InjectModel(AdminAccess.name)
    private readonly accesses: Model<AdminAccess>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.accesses.init();
  }
}
