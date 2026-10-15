import { IsWeeklySchedule, type WorkingDayDto } from '@/common/utils/working-hours';

export class PutAvailabilityDto {
  @IsWeeklySchedule()
  days!: WorkingDayDto[];
}
