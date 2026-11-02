import { IsDefined, IsTimeZone, MaxLength, ValidateIf } from 'class-validator';

/** PUT body: an IANA zone to set, or null to go back to the zone worked out from the phone. Omitting it is a 400. */
export class SetLeadTimezoneDto {
  @ValidateIf((o: SetLeadTimezoneDto) => o.timezone !== null)
  @IsDefined({ message: 'timezone is required; send null to use the zone from the phone number' })
  @IsTimeZone({ message: 'timezone must be an IANA time zone such as America/Vancouver' })
  @MaxLength(100)
  timezone!: string | null;
}
