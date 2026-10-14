import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

export class CalApiKeyDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'apiKey is required' })
  @MaxLength(255)
  apiKey!: string;
}

export class CalConnectDto extends CalApiKeyDto {
  @IsOptional()
  @IsInt()
  @IsPositive()
  teamId?: number | null;
}
