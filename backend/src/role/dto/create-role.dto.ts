import { ArrayUnique, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ALL_PERMISSIONS, type Permission } from '../permissions';

export class CreateRoleDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true, message: 'each value in permissions must be a known permission' })
  permissions!: Permission[];
}
