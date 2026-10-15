import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateLeadSourceDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsBoolean()
  requireSignature?: boolean;
}

export class ConnectFormDto {
  @IsUUID()
  credentialId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  externalFormId!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsBoolean()
  requireSignature?: boolean;

  @IsOptional()
  @IsBoolean()
  prebuildMapping?: boolean;
}

export class RotateSecretDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(7 * 24 * 60)
  graceMinutes?: number;
}

export class PauseSourceDto {
  @IsOptional()
  @IsBoolean()
  paused?: boolean;
}

export class CreateWebhookSourceDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  label!: string;
}

export class SetSourceActiveDto {
  @IsBoolean()
  active!: boolean;
}
