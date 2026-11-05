import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, IsTimeZone, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/** Asked at sign-up only to pick the owner's starting roles; it is not stored. */
export const ORGANIZATION_TYPES = ['individual', 'team'] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  organizationName!: string;

  /**
   * `individual`: the owner also works leads, so they get the Owner and Agent
   * roles. `team`: they only run the organization, so they get Owner alone.
   * Used once, here, to assign roles; roles can be changed later as usual.
   */
  @IsIn(ORGANIZATION_TYPES, { message: 'organizationType must be individual or team' })
  organizationType!: OrganizationType;

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

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  /** The office's IANA time zone, for reports and calendars; North America when left out. Outreach follows each lead's own zone. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsTimeZone({ message: 'timezone must be an IANA time zone such as America/New_York' })
  @MaxLength(100)
  timezone?: string;
}
