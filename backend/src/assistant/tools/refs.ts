import { z } from 'zod';

/**
 * The model never sees a database id. Each record a tool shows it gets a short ref, "L3" for the
 * third lead of the chat, and tools take those refs back as input. A ref only means something inside
 * the chat that issued it, and every use is checked again against what the user may see.
 */
export const REF_LETTER = { lead: 'L', user: 'U', call: 'C' } as const;

export type RefKind = keyof typeof REF_LETTER;

export interface RefTable {
  /** The id behind a ref this chat issued, if the user may still see the record. NOT_FOUND otherwise. */
  resolve(kind: RefKind, ref: string): Promise<string>;
  /** Refs for records about to be shown to the model, keyed by id. A record shown before keeps its ref. */
  issue(kind: RefKind, ids: readonly string[]): Promise<Map<string, string>>;
}

export const formatRef = (kind: RefKind, number: number): string => `${REF_LETTER[kind]}${number}`;

const MAX_DIGITS = 6;
const patternOf = (kind: RefKind) => new RegExp(`^${REF_LETTER[kind]}[1-9]\\d{0,${MAX_DIGITS - 1}}$`);

/** The number in "L3", or null when the text is not a ref of that kind. */
export function parseRef(kind: RefKind, ref: string): number | null {
  return patternOf(kind).test(ref) ? Number(ref.slice(REF_LETTER[kind].length)) : null;
}

const refInput = (kind: RefKind, what: string, from: string) =>
  z
    .string()
    .regex(patternOf(kind), `Expected a ${what} ref like ${REF_LETTER[kind]}1`)
    .describe(`${what[0].toUpperCase()}${what.slice(1)} ref like ${REF_LETTER[kind]}1, ${from}`);

export const leadRef = refInput('lead', 'lead', 'from lead_search or another result in this chat');
export const userRef = refInput('user', 'team member', 'from team_list or another result in this chat');
export const callRef = refInput('call', 'call', 'from call_list');

/** One record's ref. */
export async function refOf(refs: RefTable, kind: RefKind, id: string): Promise<string> {
  return (await refs.issue(kind, [id])).get(id)!;
}
