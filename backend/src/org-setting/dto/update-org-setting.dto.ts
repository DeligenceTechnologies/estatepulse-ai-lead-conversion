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

  /** Outreach batches keep the org's live outbound AI calls at or under this. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxConcurrentAiCalls?: number;

  /** Of those, kept free for calls outside a batch: new form leads and hot follow-ups. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(49)
  reservedCallSlots?: number;
}
