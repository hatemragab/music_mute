import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PublicPagesController } from './public-pages.controller.js';

@Module({
  imports: [ConfigModule],
  controllers: [PublicPagesController],
})
export class PublicPagesModule {}
