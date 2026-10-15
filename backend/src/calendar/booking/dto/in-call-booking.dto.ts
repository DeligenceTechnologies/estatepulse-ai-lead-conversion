import { IsUrl, MaxLength } from 'class-validator';

export class EnableInCallBookingDto {
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'Choose an event type' })
  @MaxLength(500)
  eventTypeUri!: string;
}
