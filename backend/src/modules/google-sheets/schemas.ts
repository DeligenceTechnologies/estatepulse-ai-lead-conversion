import { z } from 'zod';

/** What the callback page relays from Google. Lengths bound the work, not the format. */
export const completeOAuthSchema = z.object({
  code: z.string().min(10).max(2048),
  state: z.string().min(20).max(4096),
});
export type CompleteOAuthBody = z.infer<typeof completeOAuthSchema>;

/** Drive file ids: URL-safe base64 alphabet. Checked before it reaches a URL. */
export const spreadsheetIdSchema = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/, 'Not a Google spreadsheet id');

export const createSourceSchema = z.object({
  connectionId: z.string().uuid(),
  spreadsheetId: spreadsheetIdSchema,
  /** The tab's numeric sheetId (gid) — stable across renames, unlike its title. */
  sheetId: z.number().int().min(0),
});
export type CreateSourceBody = z.infer<typeof createSourceSchema>;

const fieldKey = z.string().trim().min(1).max(200);

/** Column -> lead field pairs, as a sheet mapping or a file upload sends them. */
export const mappingColumnsSchema = z
  .array(
    z.object({
      fieldKey,
      target: z.enum([
        'first_name',
        'last_name',
        'phone',
        'email',
        'location',
        'min_budget',
        'max_budget',
        'bedrooms',
        'motivation',
        'full_name',
        '__custom__',
      ]),
    }),
  )
  .min(1)
  .max(100);

export const saveMappingSchema = z.object({
  columns: mappingColumnsSchema,
  /**
   * The row identity. 'fallback' must be acknowledged explicitly: the owner has
   * been told that editing a phone, email or name makes a new pending lead.
   */
  identity: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('column'), fieldKey }),
    z.object({ mode: z.literal('fallback'), acknowledged: z.literal(true) }),
  ]),
});
export type SaveMappingBody = z.infer<typeof saveMappingSchema>;

/** One review decision covers at most 500 rows: bounded work per request. */
const rowIds = z
  .array(z.string().uuid())
  .min(1)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, 'Row ids must be unique');

/** Sheet row numbers (the header is row 1) to approve as they are imported: the rows the owner left ticked. */
export const approveRowsSchema = z
  .array(z.number().int().min(2).max(10_001))
  .max(10_000)
  .transform((rows) => [...new Set(rows)]);

/** Switching a sheet on. Absent or empty: every imported row waits in Import Review. */
export const enableSchema = z.object({ approveRows: approveRowsSchema.optional() }).default({});
export type EnableBody = z.infer<typeof enableSchema>;

export const decideSchema = z.object({ rowIds });
export type DecideBody = z.infer<typeof decideSchema>;

export const resolveSchema = z.object({ rowIds, action: z.enum(['apply', 'keep']) });
export type ResolveBody = z.infer<typeof resolveSchema>;

export const changesQuerySchema = z.object({
  sourceId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ChangesQuery = z.infer<typeof changesQuerySchema>;

export const reviewQuerySchema = z.object({
  /** Waiting for a decision, or rejected (kept here, out of the lead lists). */
  state: z.enum(['pending', 'rejected']).default('pending'),
  /** Where the rows came from; a sheet and an uploaded file share this queue. */
  source: z.enum(['all', 'google_sheets', 'file_upload']).default('all'),
  /** One sheet, or one uploaded file. */
  sourceId: z.string().uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ReviewQuery = z.infer<typeof reviewQuerySchema>;
