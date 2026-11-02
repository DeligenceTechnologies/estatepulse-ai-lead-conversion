import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

/** About ten SMS segments; Telnyx splits it and the lead's phone joins it back. */
export const CHAT_MESSAGE_MAX_CHARS = 1600;

export class SendChatMessageDto {
  /** Made by the browser once per message, so a retried send never texts the lead twice. */
  @IsUUID()
  id!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(CHAT_MESSAGE_MAX_CHARS)
  body!: string;
}
