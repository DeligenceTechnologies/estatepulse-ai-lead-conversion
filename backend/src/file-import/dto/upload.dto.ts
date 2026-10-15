import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class PreviewUploadDto {
  @IsOptional()
  @IsString()
  @MaxLength(64 * 1024)
  mapping?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  sheet?: string;
}

export class CommitUploadDto {
  @IsString()
  @MaxLength(64 * 1024)
  mapping!: string;

  @IsUUID()
  clientToken!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  sheet?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200 * 1024)
  approveRows?: string;

  @IsOptional()
  @IsIn(['1'])
  onlyClean?: '1';
}
