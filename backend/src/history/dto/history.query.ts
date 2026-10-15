import { LeadTemperature } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export const CALL_OUTCOMES = ['ANSWERED', 'NO_ANSWER', 'QUALIFIED', 'APPOINTMENT_BOOKED', 'HUMAN_HANDOFF', 'NOT_INTERESTED', 'FAILED', 'IN_PROGRESS'] as const;

export class CallFiltersQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsUUID()
  agentId?: string;

  @IsOptional()
  @IsIn(CALL_OUTCOMES)
  outcome?: (typeof CALL_OUTCOMES)[number];

  @IsOptional()
  @IsEnum(LeadTemperature)
  temperature?: LeadTemperature;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsUUID()
  leadId?: string;
}

export class ConversationsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsUUID()
  leadId?: string;
}

export class LeadMessagesQuery {
  @IsUUID()
  leadId!: string;
}
