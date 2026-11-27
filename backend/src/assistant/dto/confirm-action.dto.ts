import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ConfirmActionDto {
  /** The number of leads the user typed to approve a bulk card above 10 leads. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  count?: number;
}
