import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
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
  @IsOptional()
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

  /** Required, with its country code; the service checks it can be dialed. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || null : value))
  @IsString({ message: 'Add a phone number with its country code (e.g. +1 512 555 0100).' })
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

  /** Live call transfers: the AI may put a hot lead's call through to their phone (which must then be set). */
  @IsOptional()
  @IsBoolean()
  acceptsLiveTransfers?: boolean;

  /** ZIP codes or city names they cover, for routing live transfers; at least one. */
  @IsArray()
  @ArrayMinSize(1, { message: 'Add at least one area (ZIP code or city) they cover.' })
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  serviceAreas!: string[];

  /** Every role the user holds; their permissions are the union of these. */
  @IsArray()
  @ArrayNotEmpty({ message: 'Choose at least one role' })
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  roleIds!: string[];
}
