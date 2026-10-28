import { IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** 32 random bytes, base64url: what the reset and verification emails link to. */
export const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export class ResetTokenDto {
  @IsString()
  @Matches(LINK_TOKEN, { message: 'This password reset link is not valid' })
  token!: string;
}

export class ResetPasswordDto extends ResetTokenDto {
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  confirmPassword!: string;
}
