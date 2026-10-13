import { IsOptional, IsTimeZone, MaxLength } from 'class-validator';
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
}
