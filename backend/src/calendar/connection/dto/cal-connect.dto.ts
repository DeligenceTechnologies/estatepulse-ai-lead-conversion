import { IsInt, IsOptional, IsPositive } from 'class-validator';

/** PUT /org-settings/calendar/cal/workspace: a Cal.com team, or none for the personal account. */
export class CalWorkspaceDto {
  @IsOptional()
  @IsInt()
  @IsPositive()
  teamId?: number | null;
}
