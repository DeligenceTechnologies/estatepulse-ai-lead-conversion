import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { IntegrationConnectionStatus } from '@prisma/client';

/** Nango provider names and integration keys: lowercase slugs, digits, dashes, underscores, dots. */
export const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

export class ListProvidersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]{1,50}$/)
  category?: string;

  @IsOptional()
  @IsIn(['all', 'connected', 'not_connected', 'supported'])
  status?: 'all' | 'connected' | 'not_connected' | 'supported';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 60;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset: number = 0;
}

export class ListConnectionsQueryDto {
  @IsOptional()
  @IsString()
  @Matches(PROVIDER_ID)
  provider?: string;

  @IsOptional()
  @IsIn(Object.values(IntegrationConnectionStatus))
  status?: IntegrationConnectionStatus;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  includeDisconnected?: boolean;
}

/** What the browser reports after Nango's Connect UI: verified against Nango before anything is stored. */
export class ConfirmConnectionDto {
  @IsString()
  @Matches(PROVIDER_ID)
  providerConfigKey!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9._:@-]{1,255}$/)
  connectionId!: string;
}

export class UpdateSettingsDto {
  /** Provider-specific; the adapter validates every field against the provider before it is stored. */
  @IsObject()
  settings!: Record<string, unknown>;
}

export class UpdateWriteBackDto {
  @IsBoolean()
  enabled!: boolean;
}

export class ListResourcesQueryDto {
  @IsString()
  @Matches(/^[a-z_]{1,30}$/)
  kind!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{1,100}$/)
  parentId?: string;
}

export class ListRunsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
