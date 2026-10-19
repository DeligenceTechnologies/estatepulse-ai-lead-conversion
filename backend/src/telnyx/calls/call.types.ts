export const DEFAULT_CALL_LIMIT = 5;

export type CallSource = 'strategy' | 'followup';

export interface CallJobData {
  orgId: string;
  leadId: string;
  source: CallSource;
  sequenceId?: string;
}

export interface EnqueueCallOptions {
  dedupeKey: string;
}
