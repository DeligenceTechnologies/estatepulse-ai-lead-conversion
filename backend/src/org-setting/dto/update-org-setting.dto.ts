import { IsOptional, IsTimeZone, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsWeeklySchedule, type WorkingDayDto } from '@/common/utils/working-hours';

/** Only the keys sent are changed. */
export class UpdateOrgSettingDto {
  /** IANA time zone the business hours are read in, e.g. "Asia/Kolkata". */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsTimeZone({ message: 'timezone must be a valid IANA time zone, e.g. Asia/Kolkata' })
  @MaxLength(100)
  timezone?: string;

  /** All seven days. */
  @IsOptional()
  @IsWeeklySchedule()
  workingHours?: WorkingDayDto[];
}
