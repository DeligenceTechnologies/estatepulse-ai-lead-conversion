import { Module } from '@nestjs/common';
import { DailySummaryRunner } from './daily-summary.runner';

@Module({
  providers: [DailySummaryRunner],
})
export class DailySummaryModule {}
