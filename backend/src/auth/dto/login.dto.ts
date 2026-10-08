import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsBoolean()
  keepSignIn?: boolean;
}
