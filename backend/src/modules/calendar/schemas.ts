import { z } from 'zod';

/** 'HH:MM', 24-hour. */
const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM, e.g. 09:00');

/**
 * One weekday.
 *
 * `end > start` is checked here rather than left to the database, because
 * agent_availability_check would surface as a 500 with a Postgres message
 * instead of a field error the agent can act on. The DB constraint stays as the
 * backstop.
 *
 * Note it applies even when `isAvailable` is false: the constraint has no
 * exemption for days off, so an unavailable day still carries a valid pair.
 */
export const availabilityDaySchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    isAvailable: z.boolean(),
    startTime: timeOfDay,
    endTime: timeOfDay,
  })
  .refine((d) => d.endTime > d.startTime, {
    message: 'End time must be after start time',
    path: ['endTime'],
  });

/**
 * The whole week, always. A partial update would let two requests interleave
 * into a week neither caller asked for, so the write replaces all seven days.
 */
export const putAvailabilitySchema = z.object({
  days: z
    .array(availabilityDaySchema)
    .length(7, 'Send all seven days')
    .refine(
      (days) => new Set(days.map((d) => d.dayOfWeek)).size === 7,
      'Each day of week must appear exactly once',
    ),
});

export type PutAvailabilityBody = z.infer<typeof putAvailabilitySchema>;

/** Date-range filter shared by the appointment list endpoints. */
export const appointmentRangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.string().max(20).optional(),
  agentId: z.string().uuid().optional(),
  /** One lead's appointments (the lead detail view). A filter within the session's org. */
  leadId: z.string().uuid().optional(),
});

export type AppointmentRangeQuery = z.infer<typeof appointmentRangeSchema>;

/**
 * A Cal.com API key, as pasted.
 *
 * Only the shape is checked here — that it is present and looks like a Cal.com
 * key — because whether it WORKS is a question only Cal.com can answer, and the
 * connect flow asks them. Rejecting a live key because our regex was too strict
 * would be worse than one wasted round trip.
 *
 * `cal_live_` is the production prefix and `cal_` the test one, so the check is
 * the looser of the two.
 */
export const calKeySchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(1, 'Paste your Cal.com API key')
    .max(512)
    .refine((k) => k.startsWith('cal_'), 'A Cal.com API key starts with cal_'),
});

export type CalKeyBody = z.infer<typeof calKeySchema>;

/** The key plus the team the office chose from the list it unlocked. */
export const calConnectSchema = calKeySchema.extend({
  teamId: z.coerce.number().int().positive('Choose a Cal.com team'),
});

export type CalConnectBody = z.infer<typeof calConnectSchema>;
