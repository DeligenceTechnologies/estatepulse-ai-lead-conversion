import { IsBoolean, IsInt, IsOptional, IsTimeZone, Matches, Max, MaxLength, Min } from 'class-validator';
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

  /** The owners' end-of-day summary email. */
  @IsOptional()
  @IsBoolean()
  dailySummaryEnabled?: boolean;

  /** HH:MM, 24-hour, in the organization's timezone. */
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'dailySummaryTime must be a time like 21:00' })
  dailySummaryTime?: string;
}
