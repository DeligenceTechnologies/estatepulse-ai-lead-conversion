import { z } from 'zod';

/** What the callback page relays from the CRM. Lengths bound the work, not the format. */
export const completeOAuthSchema = z.object({
  code: z.string().min(8).max(2048),
  state: z.string().min(20).max(512),
});
export type CompleteOAuthBody = z.infer<typeof completeOAuthSchema>;

export const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type RunsQuery = z.infer<typeof runsQuerySchema>;
