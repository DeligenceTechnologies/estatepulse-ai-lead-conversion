import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  AGENTS_PER_TRANSFER_MAX,
  HOLD_MESSAGE_MAX_CHARS,
  RING_SECONDS_MAX,
  RING_SECONDS_MIN,
} from '../live-transfer';

export class UpdateLiveTransferDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** Seconds each agent's phone rings before the next agent is tried. */
  @IsOptional()
  @IsInt()
  @Min(RING_SECONDS_MIN)
  @Max(RING_SECONDS_MAX)
  ringSeconds?: number;

  /** Agents tried, one after another, before the AI books a meeting instead. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(AGENTS_PER_TRANSFER_MAX)
  agentsPerTransfer?: number;

  @IsOptional()
  @IsBoolean()
  onHotLead?: boolean;

  @IsOptional()
  @IsBoolean()
  onRequest?: boolean;

  /** What the lead hears while agents are rung. Empty restores the default. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(HOLD_MESSAGE_MAX_CHARS)
  holdMessage?: string;
}
