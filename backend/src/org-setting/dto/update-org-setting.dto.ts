import { IsInt, IsOptional, IsTimeZone, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsWeeklySchedule, type WorkingDayDto } from '@/common/utils/working-hours';

export class UpdateOrgSettingDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsTimeZone({ message: 'timezone must be a valid IANA time zone, e.g. Asia/Kolkata' })
  @MaxLength(100)
  timezone?: string;

  @IsOptional()
  @IsWeeklySchedule()
  workingHours?: WorkingDayDto[];

  /** Of the org's concurrent call limit (max_concurrent_calls), kept free for calls outside an outreach batch. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(499)
  reservedCallSlots?: number;
}
