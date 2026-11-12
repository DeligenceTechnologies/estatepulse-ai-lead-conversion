import { Transform } from 'class-transformer';
import { IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

/** leads.min_budget / max_budget are Decimal(12, 2): ten whole digits. */
const MAX_BUDGET = 9_999_999_999;

/** Trimmed text; an emptied field becomes null, which clears it. */
const trimOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

/**
 * A correction to a lead's own details, made by hand. Every field is optional and only the ones
 * sent change; null clears one. Status, consent, do-not-contact, the assignment and the time zone
 * are not here: each has its own route, with its own checks and audit trail.
 */
export class UpdateLeadDto {
  /** A lead always has a first name: it can be changed, never cleared. */
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== undefined)
  @IsString({ message: 'First name cannot be empty.' })
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string | null;

  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string | null;

  @Transform(trimOrNull)
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string | null;

  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string | null;

  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  timeline?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_BUDGET, { message: 'Budget is too large.' })
  minBudget?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_BUDGET, { message: 'Budget is too large.' })
  maxBudget?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  bedrooms?: number | null;

  /** Free text like the column (imports bring their own wording); the form offers pre_approved, cash_buyer, needs_lender, not_preapproved. */
  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  financingStatus?: string | null;

  /** Stored as the lead's motivation, the same column the create form's notes go to. */
  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}
