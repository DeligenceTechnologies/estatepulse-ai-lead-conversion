import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/** What the callback page relays from the CRM. Lengths bound the work, not the format. */
export class CompleteCrmOAuthDto {
  @IsString()
  @MinLength(8)
  @MaxLength(2048)
  code!: string;

  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  state!: string;
}

export class CrmRunsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/** PATCH a pending CRM contact from Import Review: only the keys sent are written to the CRM. */
export class EditCrmContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;
}
