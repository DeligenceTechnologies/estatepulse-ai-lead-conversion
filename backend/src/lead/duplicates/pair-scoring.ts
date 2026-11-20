import { canonicalEmail, nationalNumber, normalizePhone } from './identity';

export interface ScanLead {
  id: string;
  normalizedPhone: string | null;
  normalizedEmail: string | null;
}

export interface ScoredPair {
  leadAId: string;
  leadBId: string;
  score: number;
  reasons: string[];
}

/** Suggestions only start here; below it two leads are just two people. Names are never a signal:
 * two leads are one person only by a shared phone or email (or the same one written differently). */
export const SUGGEST_FROM = 60;
/** A key shared by more leads than this (an office email, a placeholder number) says nothing about who is who. */
const MAX_BUCKET = 25;

interface Signal {
  score: number;
  reason: string;
  key: (l: ScanLead) => string | null;
}

const phoneOf = (l: ScanLead) => normalizePhone(l.normalizedPhone) ?? l.normalizedPhone;
const SIGNALS: Signal[] = [
  { score: 100, reason: 'Same phone number', key: phoneOf },
  { score: 100, reason: 'Same email', key: (l) => l.normalizedEmail },
  { score: 80, reason: 'Same email inbox (dots or +tag differ)', key: (l) => canonicalEmail(l.normalizedEmail) },
  { score: 70, reason: 'Same number with a different country code', key: (l) => nationalNumber(phoneOf(l)) },
];

/**
 * Pairs of leads that look like one person, scored by their strongest shared signal (more signals
 * add their reasons, not their scores). `focus` limits it to pairs with that lead in them. Pure.
 */
export function scorePairs(leads: ScanLead[], focus?: string): ScoredPair[] {
  const pairs = new Map<string, ScoredPair>();
  for (const signal of SIGNALS) {
    const buckets = new Map<string, ScanLead[]>();
    for (const l of leads) {
      const k = signal.key(l);
      if (!k) continue;
      const bucket = buckets.get(k);
      if (bucket) bucket.push(l);
      else buckets.set(k, [l]);
    }
    for (const bucket of buckets.values()) {
      if (bucket.length < 2 || bucket.length > MAX_BUCKET) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          const [x, y] = bucket[i].id < bucket[j].id ? [bucket[i], bucket[j]] : [bucket[j], bucket[i]];
          if (focus && x.id !== focus && y.id !== focus) continue;
          const id = `${x.id}|${y.id}`;
          const pair = pairs.get(id);
          if (!pair) pairs.set(id, { leadAId: x.id, leadBId: y.id, score: signal.score, reasons: [signal.reason] });
          else {
            pair.score = Math.max(pair.score, signal.score);
            if (!pair.reasons.includes(signal.reason)) pair.reasons.push(signal.reason);
          }
        }
      }
    }
  }
  // "Same email" implies "same inbox": say the stronger one only.
  for (const p of pairs.values()) {
    if (p.reasons.includes('Same email')) p.reasons = p.reasons.filter((r) => !r.startsWith('Same email inbox'));
    if (p.reasons.includes('Same phone number')) p.reasons = p.reasons.filter((r) => r !== 'Same number with a different country code');
  }
  return [...pairs.values()].filter((p) => p.score >= SUGGEST_FROM);
}
