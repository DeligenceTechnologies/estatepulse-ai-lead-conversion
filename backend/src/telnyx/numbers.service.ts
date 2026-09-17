import { Injectable } from '@nestjs/common';
import { CredStoreService, type Creds } from './cred-store.service';

/** Per-org phone number provisioning against the tenant's Telnyx account. */
const V2 = 'https://api.telnyx.com/v2';

const H = (k: string) => ({ Authorization: `Bearer ${k}` });
/* eslint-disable @typescript-eslint/no-explicit-any */

@Injectable()
export class NumbersService {
  constructor(private readonly creds: CredStoreService) {}

  private async requireCreds(orgId: string): Promise<Creds> {
    const c = await this.creds.getCreds(orgId);
    if (!c || !c.apiKey) throw new Error('No AI provider connected — add your credentials first.');
    return c;
  }

  async searchAvailable(orgId: string, opts: { country?: string; areaCode?: string; features?: string[]; type?: string; limit?: number } = {}) {
    const c = await this.requireCreds(orgId);
    const { country = 'US', areaCode, features = ['voice', 'sms'], type = 'local', limit = 10 } = opts;
    const p = new URLSearchParams();
    p.set('filter[country_code]', country);
    if (areaCode) p.set('filter[national_destination_code]', areaCode);
    features.forEach((f) => p.append('filter[features][]', f));
    if (type) p.set('filter[phone_number_type]', type);
    p.set('filter[limit]', String(limit));
    const res = await fetch(`${V2}/available_phone_numbers?${p.toString()}`, { headers: H(c.apiKey) });
    if (!res.ok) throw new Error(`Number search failed ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as any;
    return ((j.data ?? []) as any[]).map((n) => ({
      phone_number: n.phone_number,
      upfront_cost: n.cost_information?.upfront_cost,
      monthly_cost: n.cost_information?.monthly_cost,
      currency: n.cost_information?.currency ?? 'USD',
      region: (n.region_information ?? []).map((r: any) => r.region_name).filter(Boolean).join(', '),
      features: (n.features ?? []).map((f: any) => f.name ?? f),
    }));
  }

  async listOwned(orgId: string) {
    const c = await this.requireCreds(orgId);
    const res = await fetch(`${V2}/phone_numbers?page[size]=50`, { headers: H(c.apiKey) });
    if (!res.ok) throw new Error(`List numbers failed ${res.status}`);
    const j = (await res.json()) as any;
    return ((j.data ?? []) as any[]).map((n) => ({ id: n.id, phone_number: n.phone_number, connection_id: n.connection_id ?? '', messaging_profile_id: n.messaging_profile_id ?? '' }));
  }

  async buyNumber(orgId: string, phoneNumber: string) {
    const c = await this.requireCreds(orgId);
    const res = await fetch(`${V2}/number_orders`, { method: 'POST', headers: { ...H(c.apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ phone_numbers: [{ phone_number: phoneNumber }] }) });
    if (!res.ok) throw new Error(`Number purchase failed ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as any;
    return j.data ?? j;
  }

  private async assistantTexmlAppId(orgId: string): Promise<string | null> {
    const c = await this.requireCreds(orgId);
    if (!c.assistantId) return null;
    const res = await fetch(`${V2}/ai/assistants/${c.assistantId}`, { headers: H(c.apiKey) });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    const a = j.data ?? j;
    return a.telephony_settings?.default_texml_app_id ?? null;
  }

  private async findNumberId(orgId: string, phoneNumber: string): Promise<string | null> {
    const c = await this.requireCreds(orgId);
    const res = await fetch(`${V2}/phone_numbers?filter[phone_number]=${encodeURIComponent(phoneNumber)}`, { headers: H(c.apiKey) });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    return j.data?.[0]?.id ?? null;
  }

  async assignNumber(orgId: string, phoneNumber: string) {
    const c = await this.requireCreds(orgId);
    let id: string | null = null;
    for (let i = 0; i < 5 && !id; i += 1) {
      id = await this.findNumberId(orgId, phoneNumber);
      if (!id) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!id) throw new Error('Number not found in your account yet — try assigning again in a moment.');
    const texml = await this.assistantTexmlAppId(orgId);
    const body: any = {};
    if (texml) body.connection_id = texml;
    else if (c.connectionId) body.connection_id = c.connectionId;
    if (c.messagingProfileId) body.messaging_profile_id = c.messagingProfileId;
    if (Object.keys(body).length) {
      const res = await fetch(`${V2}/phone_numbers/${id}`, { method: 'PATCH', headers: { ...H(c.apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Assign number failed ${res.status}: ${await res.text()}`);
    }
    await this.creds.saveCreds(orgId, { fromNumber: phoneNumber });
    return { phone_number: phoneNumber, routedTo: texml ? 'assistant' : c.connectionId ? 'connection' : 'none' };
  }

  async unassignNumber(orgId: string, phoneNumber: string) {
    const c = await this.requireCreds(orgId);
    const id = await this.findNumberId(orgId, phoneNumber);
    if (id) {
      await fetch(`${V2}/phone_numbers/${id}`, { method: 'PATCH', headers: { ...H(c.apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ connection_id: null }) }).catch(() => {});
    }
    if (c.fromNumber === phoneNumber) await this.creds.saveCreds(orgId, { fromNumber: '' });
    return { phone_number: phoneNumber };
  }
}
