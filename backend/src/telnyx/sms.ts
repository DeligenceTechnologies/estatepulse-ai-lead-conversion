import { getCreds } from './credStore';

/** Send an SMS from the org's own Telnyx number. */
export async function sendSms(orgId: string, to: string, text: string) {
  const c = await getCreds(orgId);
  if (!c?.apiKey) throw new Error('No provider connected');
  if (!c.fromNumber) throw new Error('No from number configured');
  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: c.fromNumber, to, text, ...(c.messagingProfileId ? { messaging_profile_id: c.messagingProfileId } : {}) }),
  });
  if (!res.ok) throw new Error(`SMS send failed ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as any;
  return j.data ?? j;
}
