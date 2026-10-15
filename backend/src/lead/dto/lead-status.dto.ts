import { FollowUpReason, LeadStatus, LeadTemperature } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class SetLeadStatusDto {
  @IsEnum(LeadStatus)
  status!: LeadStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @IsOptional()
  @IsEnum(FollowUpReason)
  followUpReason?: FollowUpReason;
}

export const AI_OUTCOMES = ['appointment_requested', 'not_interested', 'dnc', 'follow_up'] as const;

export class LeadOutcomeDto {
  @IsIn(AI_OUTCOMES)
  outcome!: (typeof AI_OUTCOMES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  summary?: string;

  @IsOptional()
  @IsEnum(FollowUpReason)
  followUpReason?: FollowUpReason;
}

export class LeadQualifiedDto {
  @IsEnum(LeadTemperature)
  temperature!: LeadTemperature;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  summary?: string;
}
