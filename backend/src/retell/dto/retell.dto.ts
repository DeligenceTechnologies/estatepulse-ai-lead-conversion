import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const E164 = /^\+[1-9][0-9]{6,14}$/;

export class RetellCredentialsDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  apiKey!: string;

  /** The key carrying the "Webhook" badge in Retell → Settings → API Keys: the only one its signatures verify against. */
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  webhookKey!: string;
}

export class CreateRetellAgentDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  voiceId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  language?: string;
}

export class UpdateRetellAgentDto {
  @IsOptional()
  @IsString()
  @MaxLength(60_000)
  prompt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  greeting?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  voiceId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  language?: string;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(7_200)
  maxCallSeconds?: number;

  @IsOptional()
  @IsBoolean()
  voicemailHangup?: boolean;

  @IsOptional()
  @IsBoolean()
  recordCalls?: boolean;
}

export class BuyRetellNumberDto {
  @IsOptional()
  @IsInt()
  @Min(200)
  @Max(999)
  areaCode?: number;

  @IsOptional()
  @IsIn(['US', 'CA'])
  countryCode?: 'US' | 'CA';

  @IsOptional()
  @IsBoolean()
  tollFree?: boolean;
}

export class ImportRetellNumberDto {
  @Transform(trim)
  @Matches(E164, { message: 'The phone number must be in E.164 format, e.g. +12025550123.' })
  phoneNumber!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  terminationUri!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  password?: string;
}

export class RetellPhoneNumberDto {
  @Transform(trim)
  @Matches(E164, { message: 'The phone number must be in E.164 format, e.g. +12025550123.' })
  phoneNumber!: string;
}

export class UpdateRetellSmsAgentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60_000)
  prompt!: string;
}

export class SwitchCallingProviderDto {
  @IsIn(['telnyx', 'retell'])
  provider!: 'telnyx' | 'retell';
}
