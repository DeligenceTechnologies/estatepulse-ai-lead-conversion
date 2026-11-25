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

/** What the confirmation card shows before a write runs. */
export interface ActionPreview {
  title: string;
  summary?: string;
  changes?: PreviewChange[];
  entity?: { type: 'lead'; id: string; version: Date };
}

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
