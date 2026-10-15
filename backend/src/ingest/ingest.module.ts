import { Module } from '@nestjs/common';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { ProcessingWorker } from './processing/worker.service';

@Module({
  controllers: [IngestController],
  providers: [IngestService, ProcessingWorker],
  exports: [IngestService, ProcessingWorker],
})
export class IngestModule {}
