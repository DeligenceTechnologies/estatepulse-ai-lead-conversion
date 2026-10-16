import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/** leads.min_budget / max_budget are Decimal(12, 2): ten whole digits. */
const MAX_BUDGET = 9_999_999_999;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

/** One lead typed in by hand. A phone or an email is required; the service checks that. */
export class CreateLeadDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @Transform(trim)
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  timeline?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_BUDGET, { message: 'Budget is too large.' })
  minBudget?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_BUDGET, { message: 'Budget is too large.' })
  maxBudget?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  bedrooms?: number;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  /** The lead agreed to be called and texted. */
  @IsBoolean()
  consent!: boolean;

  /** Let the AI start calling right away; otherwise the lead waits paused. */
  @IsBoolean()
  startOutreach!: boolean;
}
