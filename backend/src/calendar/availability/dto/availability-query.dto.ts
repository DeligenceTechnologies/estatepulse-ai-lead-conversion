import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches } from 'class-validator';

export const AVAILABILITY_SPANS = [1, 7] as const;

export class AvailabilityQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn(AVAILABILITY_SPANS, { message: 'days must be 1 or 7' })
  days?: number;
}
