import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProcessingModule } from '../processing/processing.module';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';

@Module({
  imports: [PrismaModule, ProcessingModule],
  controllers: [IngestController],
  providers: [IngestService],
  exports: [IngestService],
})
export class IngestModule {}
