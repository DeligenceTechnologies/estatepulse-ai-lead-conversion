import { Transform } from 'class-transformer';
import { IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

/** leads.min_budget / max_budget are Decimal(12, 2): ten whole digits. */
const MAX_BUDGET = 9_999_999_999;

/**
 * Unlike the create form, "" is meaningful here: it clears the field. A key left out is left
 * alone, so a caller can send one correction without resending the rest of the lead.
 */
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Only set when the caller sent something other than "" — so clearing a field skips its format check. */
const filled = (key: keyof UpdateLeadDto) => (o: UpdateLeadDto) => o[key] !== '';

/**
 * The details of an existing lead, corrected by hand. The same fields the owner can type in
 * when adding a lead — notably the phone, which is how a lead imported without a country code
 * is made dialable without touching the sheet it came from.
 *
 * Consent, status, assignment and outreach are not here: each has its own endpoint, because
 * each means something the owner has to choose on purpose rather than while fixing a typo.
 */
export class UpdateLeadDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'First name cannot be empty.' })
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  lastName?: string;

  /** "" clears it. Anything else must carry its country code; the service checks that it dials. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @Transform(trim)
  @ValidateIf(filled('email'))
  @IsEmail({}, { message: 'email must be an email address, or "" to clear it' })
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  location?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  timeline?: string;

  /** null clears it. */
  @IsOptional()
  @ValidateIf((o: UpdateLeadDto) => o.minBudget !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_BUDGET, { message: 'Budget is too large.' })
  minBudget?: number | null;

  /** null clears it. */
  @IsOptional()
  @ValidateIf((o: UpdateLeadDto) => o.maxBudget !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_BUDGET, { message: 'Budget is too large.' })
  maxBudget?: number | null;

  /** null clears it. */
  @IsOptional()
  @ValidateIf((o: UpdateLeadDto) => o.bedrooms !== null)
  @IsInt()
  @Min(0)
  @Max(50)
  bedrooms?: number | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
