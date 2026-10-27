import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { LINK_TOKEN } from './reset-password.dto';

export class VerifyEmailDto {
  @IsString()
  @Matches(LINK_TOKEN, { message: 'This verification link is not valid' })
  token!: string;
}

export class ResendVerificationDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(255)
  email!: string;
}
