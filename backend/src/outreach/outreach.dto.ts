import { IsIn, IsTimeZone, Matches, MaxLength, ValidateIf } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class RescheduleDto {
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @Matches(TIME, { message: 'time must be HH:mm (24-hour)' })
  time!: string;

  @IsTimeZone({ message: 'timeZone must be a valid IANA time zone, e.g. Asia/Kolkata' })
  @MaxLength(100)
  timeZone!: string;
}

/** How approved leads launch: now, or at a wall-clock time in a zone. */
export class OutreachChoiceDto {
  @IsIn(['now', 'scheduled'])
  mode!: 'now' | 'scheduled';

  @ValidateIf((o: OutreachChoiceDto) => o.mode === 'scheduled')
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  @ValidateIf((o: OutreachChoiceDto) => o.mode === 'scheduled')
  @Matches(TIME, { message: 'time must be HH:mm (24-hour)' })
  time?: string;

  @ValidateIf((o: OutreachChoiceDto) => o.mode === 'scheduled')
  @IsTimeZone({ message: 'timeZone must be a valid IANA time zone, e.g. Asia/Kolkata' })
  @MaxLength(100)
  timeZone?: string;
}
