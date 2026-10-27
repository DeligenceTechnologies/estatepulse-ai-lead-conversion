import { LeadTemperature, SequenceStatus, SequenceTrigger } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const unique = ({ value }: { value: unknown }) => (Array.isArray(value) ? [...new Set(value)] : value);

export class SequenceStepDto {
  @IsIn(['sms', 'voice'])
  actionType!: 'sms' | 'voice';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(525_600)
  delayMinutes!: number;

  @ValidateIf((s: SequenceStepDto) => s.actionType === 'sms')
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'An SMS step needs a message' })
  @MaxLength(1600)
  messageTemplate?: string | null;

  @ValidateIf((s: SequenceStepDto) => s.actionType === 'voice')
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'An AI callback step needs a prompt' })
  @MaxLength(2000)
  voicePrompt?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  maxAttempts?: number;

  /** Only send this step if…: 'call_not_answered' (the lead's last call rang out) or 'not_reached' (no answer or reply since enrolment). */
  @IsOptional()
  @IsIn(['always', 'call_not_answered', 'not_reached'])
  condition?: 'always' | 'call_not_answered' | 'not_reached';

  /** "Only if": { match: 'all' | 'any', rules: [{ field, op, value }] }; checked against the sequence fields. */
  @IsOptional()
  @IsObject()
  onlyIf?: Record<string, unknown>;
}

export class ReplaceStepsDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'A sequence needs at least one step' })
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SequenceStepDto)
  steps!: SequenceStepDto[];
}

export class CreateSequenceDto extends ReplaceStepsDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @Transform(trim)
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/, { message: 'Code must be UPPER_SNAKE_CASE' })
  code!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(SequenceStatus)
  status?: SequenceStatus;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @Transform(unique)
  @IsEnum(SequenceTrigger, { each: true })
  enrollTriggers?: SequenceTrigger[];
}

export class UpdateSequenceDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @IsEnum(SequenceStatus)
  status?: SequenceStatus;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @Transform(unique)
  @IsEnum(SequenceTrigger, { each: true })
  enrollTriggers?: SequenceTrigger[];
}

export class LeadFilterDto {
  @IsOptional()
  @IsEnum(LeadTemperature)
  temperature?: LeadTemperature;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  status?: string;

  @IsOptional()
  @IsUUID()
  sourceId?: string;

  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @IsOptional()
  @IsBoolean()
  noReply?: boolean;

  @IsOptional()
  @IsBoolean()
  neverContacted?: boolean;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class EnrollLeadsDto {
  @ValidateIf((b: EnrollLeadsDto) => !b.filter)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  leadIds?: string[];

  @ValidateIf((b: EnrollLeadsDto) => !b.leadIds)
  @ValidateNested()
  @Type(() => LeadFilterDto)
  filter?: LeadFilterDto;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
