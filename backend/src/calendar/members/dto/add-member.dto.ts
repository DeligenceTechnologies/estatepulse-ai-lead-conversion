import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AddCalendarMemberDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  externalId!: string;
}
