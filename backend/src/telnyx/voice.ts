import { getCreds } from './credStore';

/**
 * Place an outbound AI qualification call from the org's Telnyx number.
 * Requires a Call Control connection id. On answer the AI assistant is attached
 * via the Call Control webhook (not yet wired in this backend — see notes).
 */
export async function placeCall(orgId: string, to: string, clientState: Record<string, unknown>) {
  const c = await getCreds(orgId);
  if (!c?.apiKey) throw new Error('No provider connected');
  if (!c.connectionId) throw new Error('No voice connection configured');
  if (!c.fromNumber) throw new Error('No from number configured');
  const res = await fetch('https://api.telnyx.com/v2/calls', {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      connection_id: c.connectionId,
      to,
      from: c.fromNumber,
      client_state: Buffer.from(JSON.stringify(clientState)).toString('base64'),
      ...(process.env.PUBLIC_API_URL ? { webhook_url: `${process.env.PUBLIC_API_URL}/api/webhooks/telnyx/voice` } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Call failed ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as any;
  return j.data ?? j;
}
