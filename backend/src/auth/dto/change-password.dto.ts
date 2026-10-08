import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  oldPassword!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  newPassword!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  confirmPassword!: string;
}
