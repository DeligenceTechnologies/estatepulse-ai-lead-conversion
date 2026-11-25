import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class SendMessageDto {
  /** Omitted to start a new chat. */
  @IsOptional()
  @IsUUID()
  threadId?: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  text!: string;

  /** The screen the user is on, e.g. "Leads" or "Lead: Rahul Sharma (id …)", so "this lead" resolves. */
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  screen?: string;
}
