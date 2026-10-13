import { CalendarProvider } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class ActivateCalendarDto {
  @IsEnum(CalendarProvider, { message: 'provider must be calendly or cal' })
  provider!: CalendarProvider;
}
