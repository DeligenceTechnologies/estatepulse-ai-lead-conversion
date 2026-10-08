import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CreateUserDto } from './create-user.dto';

/** A user cannot be moved to another organization. */
export class UpdateUserDto extends PartialType(OmitType(CreateUserDto, ['orgId'] as const)) {
  /** Sets a new password for the user (an admin reset). */
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password?: string;
}
