import { Injectable } from '@nestjs/common';
import { AppError } from '@/common/errors/app-error';
import { TelnyxCredentialsService, type TelnyxCreds } from './telnyx-credentials.service';
import { telnyx } from './telnyx-api';

interface SearchOptions {
  country: string;
  areaCode?: string;
  features?: string[];
  type?: string;
  limit?: number;
}

/** Searching, buying and routing phone numbers on the organization's Telnyx account. */
@Injectable()
export class NumbersService {
  constructor(private readonly creds: TelnyxCredentialsService) {}

  private async requireCreds(orgId: string): Promise<TelnyxCreds> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new AppError('CONFLICT', 'No AI provider connected — add your credentials first.');
    return c;
  }

  async searchAvailable(orgId: string, opts: SearchOptions) {
    const c = await this.requireCreds(orgId);
    const p = new URLSearchParams();
    p.set('filter[country_code]', opts.country);
    if (opts.areaCode) p.set('filter[national_destination_code]', opts.areaCode);
    (opts.features ?? ['voice', 'sms']).forEach((f) => p.append('filter[features][]', f));
    if (opts.type) p.set('filter[phone_number_type]', opts.type);
    p.set('filter[limit]', String(opts.limit ?? 10));
    const res = await telnyx<{ data?: any[] }>(c.apiKey, `/available_phone_numbers?${p}`);
    return (res.data ?? []).map((n) => ({
      phone_number: n.phone_number,
      upfront_cost: n.cost_information?.upfront_cost,
      monthly_cost: n.cost_information?.monthly_cost,
      currency: n.cost_information?.currency ?? 'USD',
      region: (n.region_information ?? []).map((r: { region_name?: string }) => r.region_name).filter(Boolean).join(', '),
      features: (n.features ?? []).map((f: { name?: string } | string) => (typeof f === 'string' ? f : f.name)),
    }));
  }

  async listOwned(orgId: string) {
    const c = await this.requireCreds(orgId);
    const res = await telnyx<{ data?: any[] }>(c.apiKey, '/phone_numbers?page[size]=50');
    return (res.data ?? []).map((n) => ({
      id: n.id,
      phone_number: n.phone_number,
      connection_id: n.connection_id ?? '',
      messaging_profile_id: n.messaging_profile_id ?? '',
    }));
  }

  async buyNumber(orgId: string, phoneNumber: string) {
    const c = await this.requireCreds(orgId);
    const res = await telnyx<{ data?: unknown }>(c.apiKey, '/number_orders', {
      method: 'POST',
      body: JSON.stringify({ phone_numbers: [{ phone_number: phoneNumber }] }),
    });
    return res.data ?? res;
  }

  /** Routes the number to the AI assistant (or the Call Control app) and makes it the from-number. */
  async assignNumber(orgId: string, phoneNumber: string) {
    const c = await this.requireCreds(orgId);
    let id: string | null = null;
    for (let i = 0; i < 5 && !id; i += 1) {
      id = await this.findNumberId(c.apiKey, phoneNumber);
      if (!id) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!id) throw new AppError('CONFLICT', 'Number not found in your account yet — try assigning again in a moment.');
    const texml = await this.assistantTexmlAppId(c);
    const body: Record<string, string> = {};
    if (texml) body.connection_id = texml;
    else if (c.connectionId) body.connection_id = c.connectionId;
    if (c.messagingProfileId) body.messaging_profile_id = c.messagingProfileId;
    if (Object.keys(body).length) await telnyx(c.apiKey, `/phone_numbers/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    await this.creds.saveCreds(orgId, { fromNumber: phoneNumber });
    return { phone_number: phoneNumber, routedTo: texml ? 'assistant' : c.connectionId ? 'connection' : 'none' };
  }

  async unassignNumber(orgId: string, phoneNumber: string) {
    const c = await this.requireCreds(orgId);
    const id = await this.findNumberId(c.apiKey, phoneNumber);
    if (id) await telnyx(c.apiKey, `/phone_numbers/${id}`, { method: 'PATCH', body: JSON.stringify({ connection_id: null }) }).catch(() => undefined);
    if (c.fromNumber === phoneNumber) await this.creds.saveCreds(orgId, { fromNumber: '' });
    return { phone_number: phoneNumber };
  }

  private async assistantTexmlAppId(c: TelnyxCreds): Promise<string | null> {
    if (!c.assistantId) return null;
    const res = await telnyx<any>(c.apiKey, `/ai/assistants/${c.assistantId}`).catch(() => null);
    return (res?.data ?? res)?.telephony_settings?.default_texml_app_id ?? null;
  }

  private async findNumberId(apiKey: string, phoneNumber: string): Promise<string | null> {
    const res = await telnyx<{ data?: { id?: string }[] }>(apiKey, `/phone_numbers?filter[phone_number]=${encodeURIComponent(phoneNumber)}`).catch(() => null);
    return res?.data?.[0]?.id ?? null;
  }
}
