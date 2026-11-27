import { IsBoolean, IsNumber, IsOptional, Max, Min, ValidateIf } from 'class-validator';
import { MAX_MONTHLY_LIMIT_USD } from '../assistant-settings.service';

/** Only the keys sent change. `monthlyLimitUsd: null` goes back to the plan's allowance. */
export class UpdateAssistantSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ValidateIf((o: UpdateAssistantSettingsDto) => o.monthlyLimitUsd !== null && o.monthlyLimitUsd !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(MAX_MONTHLY_LIMIT_USD)
  monthlyLimitUsd?: number | null;

  @IsOptional()
  @IsBoolean()
  voiceEnabled?: boolean;
}
