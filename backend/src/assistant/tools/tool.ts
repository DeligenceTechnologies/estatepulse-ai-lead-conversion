import type { z } from 'zod';
import type { AuthContext } from '@/auth/auth.types';
import type { Permission } from '@/role/permissions';
import type { RefTable } from './refs';

export interface ToolContext {
  auth: AuthContext;
  /** Refs of the chat the tool runs in: inputs arrive as refs, and results show refs, never ids. */
  refs: RefTable;
}

export interface PreviewChange {
  field: string;
  from: string | null;
  to: string | null;
}

/** The leads a bulk card will act on, frozen when the card is built. */
export interface BulkPreview {
  /** In the order they will run. */
  leadIds: string[];
  /** Left out, by reason: { 'already with Priya Shah': 6 }. */
  skipped: Record<string, number>;
  /** A few names for the card. */
  sample: string[];
}

/** What the confirmation card shows before a write runs. */
export interface ActionPreview {
  title: string;
  summary?: string;
  changes?: PreviewChange[];
  entity?: { type: 'lead'; id: string; version: Date };
  /** Set by a bulk tool: the card acts on these leads, in a background job. */
  bulk?: BulkPreview;
}

/** What one lead of a bulk job came to: done, or left alone with the reason. */
export type BulkOutcome = void | { skipped: string };

interface ToolBase<TSchema extends z.ZodType> {
  name: string;
  description: string;
  /** Shown while the tool runs, e.g. "Searching leads". */
  label: string;
  input: TSchema;
  /** Every one is required; a user without them never sees the tool. */
  permissions: readonly Permission[];
}

export interface ReadTool<TSchema extends z.ZodType = z.ZodType> extends ToolBase<TSchema> {
  tier: 'read';
  run(ctx: ToolContext, input: z.infer<TSchema>): Promise<unknown>;
}

export interface WriteTool<TSchema extends z.ZodType = z.ZodType> extends ToolBase<TSchema> {
  tier: 'write';
  /** Read-only: describes the change for the user to confirm. Throws when the target is not visible. */
  preview(ctx: ToolContext, input: z.infer<TSchema>): Promise<ActionPreview>;
  run(ctx: ToolContext, input: z.infer<TSchema>): Promise<unknown>;
  /**
   * A bulk tool: its preview returns `bulk`, and approving runs `runOne` for each frozen lead in a
   * background job instead of `run`. A refusal for one lead (an AppError) skips that lead only.
   */
  bulk?: { runOne(ctx: ToolContext, input: z.infer<TSchema>, leadId: string): Promise<BulkOutcome> };
}

export type AssistantTool = ReadTool | WriteTool;

export const readTool = <TSchema extends z.ZodType>(tool: Omit<ReadTool<TSchema>, 'tier'>): AssistantTool =>
  ({ ...tool, tier: 'read' }) as AssistantTool;

export const writeTool = <TSchema extends z.ZodType>(tool: Omit<WriteTool<TSchema>, 'tier'>): AssistantTool =>
  ({ ...tool, tier: 'write' }) as AssistantTool;

export const display = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
};
