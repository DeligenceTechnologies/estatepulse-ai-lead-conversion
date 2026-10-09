import { BaseStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { IsWeeklySchedule, type WorkingDayDto } from '@/common/utils/working-hours';

export class CreateUserDto {
  @IsUUID()
  orgId!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  phone!: string;

  /** IANA time zone, e.g. "Asia/Kolkata"; the database defaults to Asia/Kolkata. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsTimeZone({ message: 'timezone must be a valid IANA time zone, e.g. Asia/Kolkata' })
  @MaxLength(100)
  timezone?: string;

  /** How many leads routing may hand them at once; 0 = none. The database defaults to 25. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  maxActiveLeads?: number;

  /** All seven days; the database defaults to Monday-Friday 09:00-18:00, weekends off. */
  @IsOptional()
  @IsWeeklySchedule()
  workingHours?: WorkingDayDto[];

  /** Every role the user holds; their permissions are the union of these. */
  @IsArray()
  @ArrayNotEmpty({ message: 'Choose at least one role' })
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  roleIds!: string[];
}
