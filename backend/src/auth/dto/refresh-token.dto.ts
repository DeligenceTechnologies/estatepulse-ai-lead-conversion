import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RefreshTokenDto {
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  refreshToken?: string;
}
