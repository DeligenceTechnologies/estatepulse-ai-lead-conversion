import { Module } from '@nestjs/common';
import { StepGuard } from './step-guard.service';

/** The outreach safety rules, shared by the strategy engine and the sequence runner whatever the calling provider. */
@Module({
  providers: [StepGuard],
  exports: [StepGuard],
})
export class StepGuardModule {}
