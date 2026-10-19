import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class TelnyxCredentialsDto {
  @IsOptional()
  @Transform(trim)
  @Matches(/^KEY/, { message: 'A valid Telnyx API key (starts with "KEY") is required.' })
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  publicKey?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  connectionId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  messagingProfileId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  fromNumber?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  label?: string;
}

/** POST /telnyx/numbers/lookup: a key to verify, or none to use the stored one. */
export class NumbersLookupDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsString()
  @Matches(/^KEY/, { message: 'A valid Telnyx API key (starts with "KEY") is required.' })
  @MaxLength(500)
  apiKey?: string;
}

export class RenameAccountDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'A name is required.' })
  @MaxLength(100)
  label!: string;
}

export class ReconnectDto {
  @IsOptional()
  @IsUUID()
  accountId?: string;
}

export class CreateAssistantDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  greeting?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  instructions?: string;
}

export class AttachAssistantDto {
  @IsString()
  @IsNotEmpty({ message: 'assistantId is required' })
  @MaxLength(200)
  assistantId!: string;
}

export class PhoneNumberDto {
  @Transform(trim)
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'phone_number must be in E.164 format' })
  phone_number!: string;
}

export class StrategyStepAfterDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  value!: number;

  @IsIn(['seconds', 'minutes', 'hours', 'days'])
  unit!: 'seconds' | 'minutes' | 'hours' | 'days';
}

export class StrategyStepDto {
  @IsString()
  @MaxLength(50)
  id!: string;

  @ValidateNested()
  @Type(() => StrategyStepAfterDto)
  after!: StrategyStepAfterDto;

  @IsIn(['sms', 'voice'])
  channel!: 'sms' | 'voice';

  @IsOptional()
  @IsString()
  @MaxLength(50)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  template?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1600)
  message?: string;
}

export class StrategyDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsObject()
  guardrails?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => StrategyStepDto)
  steps?: StrategyStepDto[];
}

export class ThresholdsDto {
  @IsInt()
  @Min(1)
  @Max(100)
  hotThreshold!: number;

  @IsInt()
  @Min(1)
  @Max(100)
  warmThreshold!: number;
}

export class TestToolDto {
  @IsOptional()
  @IsObject()
  arguments?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  dynamic_variables?: Record<string, unknown>;
}

export class SetToolsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsObject({ each: true })
  tools!: Record<string, unknown>[];
}

export class CallCapacityDto {
  @IsInt()
  @Min(1)
  @Max(500)
  maxConcurrentCalls!: number;
}
