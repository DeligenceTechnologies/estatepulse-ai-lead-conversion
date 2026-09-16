/**
 * Normalizes an inbound webhook body into a lead. Understands two shapes:
 *  - Tally  (`{ data: { fields: [...] } }`) — the format our forms post
 *  - Generic (`{ first_name, last_name, email, phone, ... }`) — anything else
 */
export interface ParsedLead {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

/** Best-effort E.164: keep digits (and a leading +), drop separators. */
export function normalizePhone(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  return plus ? `+${digits}` : `+${digits.replace(/^0+/, '')}`;
}

export const normalizeEmail = (raw: unknown): string => String(raw ?? '').trim().toLowerCase();

function parseTally(fields: any[]): ParsedLead {
  const readValue = (f: any): string => {
    const v = f?.value;
    if (Array.isArray(v)) {
      const opts: any[] = f?.options ?? [];
      return v.map((id) => opts.find((o) => o?.id === id)?.text ?? id).join(', ');
    }
    return v == null ? '' : String(v);
  };
  const find = (pred: (f: any) => boolean): string => {
    const f = fields.find(pred);
    return f ? readValue(f) : '';
  };
  const byType = (t: string) => (f: any) => String(f?.type ?? '').toUpperCase().includes(t);
  const byLabel = (s: string) => (f: any) => String(f?.label ?? '').toLowerCase().includes(s);

  const phone = find((f) => byType('PHONE')(f) || byLabel('phone')(f));
  const email = find((f) => byType('EMAIL')(f) || byLabel('email')(f));
  let firstName = find(byLabel('first name'));
  let lastName = find(byLabel('last name'));
  if (!firstName && !lastName) {
    const [a, ...rest] = find(byLabel('name')).trim().split(/\s+/);
    firstName = a ?? '';
    lastName = rest.join(' ');
  }
  return { firstName, lastName, email, phone };
}

export function parsePayload(body: any): ParsedLead {
  const fields = body?.data?.fields;
  if (Array.isArray(fields)) return parseTally(fields);

  const name = String(body?.name ?? '').trim();
  const [gf, ...gr] = name.split(/\s+/);
  return {
    firstName: String(body?.first_name ?? body?.firstName ?? gf ?? ''),
    lastName: String(body?.last_name ?? body?.lastName ?? gr.join(' ') ?? ''),
    email: String(body?.email ?? ''),
    phone: String(body?.phone ?? body?.phone_number ?? body?.phoneNumber ?? ''),
  };
}
