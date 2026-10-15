/** '+1 (202) 555-0123' → '+12025550123'. A number without a + is assumed to carry its country code. */
export function normalizePhone(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  return s.startsWith('+') ? `+${digits}` : `+${digits.replace(/^0+/, '')}`;
}
