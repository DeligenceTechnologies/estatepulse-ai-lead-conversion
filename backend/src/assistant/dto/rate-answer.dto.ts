import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { FEEDBACK_REASONS, type FeedbackReason } from '../assistant-thread.service';

/** The whole rating each time. A reason and comment are kept only with a thumbs down. */
export class RateAnswerDto {
  /** null (or left out) takes the rating back. */
  @IsOptional()
  @IsIn(['up', 'down'])
  rating?: 'up' | 'down' | null;

  @IsOptional()
  @IsIn(FEEDBACK_REASONS)
  reason?: FeedbackReason | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string | null;
}
