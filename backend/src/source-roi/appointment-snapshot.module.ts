import { Module } from '@nestjs/common';
import { AppointmentSnapshotService } from './appointment-snapshot.service';

/**
 * On its own so the calendar module can import it without importing the rest
 * of Source ROI. It depends only on the global providers (Prisma, lead state).
 */
@Module({
  providers: [AppointmentSnapshotService],
  exports: [AppointmentSnapshotService],
})
export class AppointmentSnapshotModule {}
