import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProcessingWorker } from './worker.service';

@Module({
  imports: [PrismaModule],
  providers: [ProcessingWorker],
  exports: [ProcessingWorker],
})
export class ProcessingModule {}
