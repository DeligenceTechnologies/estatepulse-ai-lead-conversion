import type { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateNested,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';

/**
 * A weekly schedule — a user's working hours, or the organization's business
 * hours — stored as JSON: one entry per day, wall-clock in the owner's timezone.
 */

/** Monday-Friday 09:00-18:00, weekend off: what both users and organizations start with. */
export const DEFAULT_WORKING_HOURS: readonly WorkingDay[] = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek,
  isAvailable: dayOfWeek >= 1 && dayOfWeek <= 5,
  startTime: '09:00',
  endTime: '18:00',
}));

/** One day of a weekly schedule. */
export class WorkingDayDto {
  /** 0 = Sunday .. 6 = Saturday. */
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @IsBoolean()
  isAvailable!: boolean;

  /** "HH:MM", 24-hour. Kept on a day off too, so switching it back on restores the hours. */
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'startTime must be HH:MM (24-hour)' })
  startTime!: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'endTime must be HH:MM (24-hour)' })
  endTime!: string;
}

export type WorkingDay = Pick<WorkingDayDto, 'dayOfWeek' | 'isAvailable' | 'startTime' | 'endTime'>;

/**
 * Every day of the week exactly once, each ending after it starts. Stored as
 * the user's `working_hours` JSON, which the column defaults to Monday-Friday
 * 09:00-18:00 with the weekend off.
 */
export function IsWeeklySchedule(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => {
    ValidateNested({ each: true })(target, propertyName);
    Type(() => WorkingDayDto)(target, propertyName);
    ArrayMinSize(7)(target, propertyName);
    ArrayMaxSize(7)(target, propertyName);
    registerDecorator({
      name: 'isWeeklySchedule',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: 'workingHours must list each day of the week once, every end time after its start time',
        ...options,
      },
      validator: {
        validate: (days: unknown) =>
          Array.isArray(days) &&
          new Set(days.map((day: WorkingDay) => day?.dayOfWeek)).size === 7 &&
          days.every((day: WorkingDay) => typeof day?.startTime !== 'string' || day.startTime < day.endTime),
      },
    });
  };
}

/** Plain, Sunday-first objects for the JSON column (the DTO instances carry class prototypes). */
export function toWorkingHoursJson(days: readonly WorkingDay[]): Prisma.InputJsonArray {
  return [...days]
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map(({ dayOfWeek, isAvailable, startTime, endTime }) => ({ dayOfWeek, isAvailable, startTime, endTime }));
}
