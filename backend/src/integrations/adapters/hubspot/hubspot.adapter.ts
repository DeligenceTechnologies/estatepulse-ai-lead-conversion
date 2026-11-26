import { Injectable, Logger } from '@nestjs/common';
import { LeadSourceProvider } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import type {
  AccountIdentity,
  AdapterContext,
  AdapterImport,
  AdapterSetup,
  AdapterWriteBack,
  ImportPage,
  ImportedRecord,
  IntegrationAdapter,
  SetupResource,
  SetupState,
} from '../adapter.interface';
import { NangoError } from '../../nango/nango.service';
import { WriteRefused, type SyncField, type SyncValue } from '../../sync/two-way';

/**
 * HubSpot through Nango. Nango's "hubspot" provider proxies to
 * https://api.hubapi.com.
 *
 * Endpoints (HubSpot CRM API v3):
 *  - GET   /account-info/v3/details                  portal id, time zone (any OAuth token)
 *  - GET   /crm/v3/objects/contacts?limit=&after=&properties=&archived=false   (crm.objects.contacts.read)
 *  - GET   /crm/v3/properties/contacts               contact properties, for the mapping (crm.schemas.contacts.read)
 *  - PATCH /crm/v3/objects/contacts/{id}             two-way write-back (crm.objects.contacts.write)
 *
 * Contacts only. Companies and deals are NOT synced yet; they need their own
 * scopes and a product decision on how they map to leads, so they are not advertised.
 * HubSpot's per-app limit is 100–190 requests / 10 s; Nango's proxy retries its 429s.
 */

const PAGE_SIZE = 100;

const BASE_PROPERTIES = [
  'firstname',
  'lastname',
  'email',
  'phone',
  'mobilephone',
  'city',
  'state',
  'country',
  'lifecyclestage',
  'hs_lead_status',
  'message',
] as const;

/** Lead fields that can be mapped to a HubSpot contact property of the owner's choice. */
export const MAPPABLE_TARGETS = ['minBudget', 'maxBudget', 'bedrooms', 'timeline', 'location', 'motivation'] as const;
type MappableTarget = (typeof MAPPABLE_TARGETS)[number];
const NUMERIC_TARGETS: ReadonlySet<MappableTarget> = new Set(['minBudget', 'maxBudget', 'bedrooms']);
export type PropertyMap = Partial<Record<MappableTarget, string>>;

/** Lead fields always exchanged with their standard HubSpot property. */
const STANDARD: Partial<Record<SyncField, string>> = {
  firstName: 'firstname',
  lastName: 'lastname',
  email: 'email',
  motivation: 'message',
};

const PROPERTY_NAME = /^[a-z0-9_]{1,100}$/;

interface HubSpotContact {
  id: string;
  properties?: Record<string, string | null | undefined>;
}

interface HubSpotProperty {
  name: string;
  label?: string;
  type?: string;
  fieldType?: string;
  hidden?: boolean;
  calculated?: boolean;
  hubspotDefined?: boolean;
  modificationMetadata?: { readOnlyValue?: boolean };
}

interface Cursor {
  after: string;
}

const clean = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const toNumber = (v: string | null | undefined): number | null => {
  const text = clean(v);
  if (!text) return null;
  const n = Number(text.replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

export function readPropertyMap(settings: Record<string, unknown>): PropertyMap {
  const raw = settings.propertyMap;
  const out: PropertyMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const target of MAPPABLE_TARGETS) {
    const name = (raw as Record<string, unknown>)[target];
    if (typeof name === 'string' && PROPERTY_NAME.test(name)) out[target] = name;
  }
  return out;
}

export function contactToRecord(contact: HubSpotContact, map: PropertyMap = {}): ImportedRecord {
  const p = contact.properties ?? {};
  const customFields: Record<string, string> = {};
  if (clean(p.lifecyclestage)) customFields['HubSpot lifecycle stage'] = clean(p.lifecyclestage)!;
  if (clean(p.hs_lead_status)) customFields['HubSpot lead status'] = clean(p.hs_lead_status)!;

  // A mobile number is what the AI calls and texts; the main phone is the fallback. Remember which one it was.
  const mobile = clean(p.mobilephone);
  const phone = mobile ?? clean(p.phone);
  const record: ImportedRecord = {
    objectType: 'hubspot:contact',
    externalId: contact.id,
    firstName: clean(p.firstname),
    lastName: clean(p.lastname),
    email: clean(p.email),
    phone,
    location: map.location ? clean(p[map.location]) : [clean(p.city), clean(p.state), clean(p.country)].filter(Boolean).join(', ') || null,
    motivation: clean(p[map.motivation ?? 'message']),
    customFields,
    meta: { phoneProperty: mobile ? 'mobilephone' : 'phone' },
  };
  if (map.timeline) record.timeline = clean(p[map.timeline]);
  if (map.minBudget) record.minBudget = toNumber(p[map.minBudget]);
  if (map.maxBudget) record.maxBudget = toNumber(p[map.maxBudget]);
  if (map.bedrooms) {
    const beds = toNumber(p[map.bedrooms]);
    record.bedrooms = beds === null ? null : Math.round(beds);
  }
  return record;
}

/** Properties the owner may map: visible, writable, and of a type the lead field fits. */
function mappable(property: HubSpotProperty, target: MappableTarget): boolean {
  if (property.hidden || property.calculated || property.modificationMetadata?.readOnlyValue) return false;
  if (NUMERIC_TARGETS.has(target)) return property.type === 'number';
  return property.type === 'string' && (property.fieldType === 'text' || property.fieldType === 'textarea');
}

@Injectable()
export class HubSpotAdapter implements IntegrationAdapter {
  private readonly logger = new Logger(HubSpotAdapter.name);

  readonly provider = 'hubspot';
  readonly displayName = 'HubSpot';
  readonly description =
    'Sync HubSpot contacts with your leads, both ways. Connect one or several HubSpot portals; each one syncs on its own.';
  readonly features = [
    'Connect several HubSpot portals',
    'Imports contacts with name, email, phone (mobile first) and location',
    'Map budget, bedrooms, timeline and more to your own HubSpot properties',
    'Two-way sync: changes made in EstatePulse are written back to the HubSpot contact',
    'Lifecycle stage and lead status are kept on the lead',
    'Unchanged contacts are skipped on every re-sync; a person already in EstatePulse is never duplicated',
  ] as const;
  readonly capabilities = ['lead_import', 'contacts'] as const;
  readonly fallbackCategories = ['crm', 'marketing'] as const;
  readonly requiredScopes = ['oauth', 'crm.objects.contacts.read'] as const;
  readonly leadSourceProvider = LeadSourceProvider.HUBSPOT;

  async identify(ctx: AdapterContext): Promise<AccountIdentity> {
    try {
      const info = await ctx.client.get<{ portalId?: number; uiDomain?: string; timeZone?: string; accountType?: string }>(
        '/account-info/v3/details',
      );
      const portal = info.portalId ? String(info.portalId) : null;
      return {
        accountName: portal ? `HubSpot portal ${portal}` : null,
        accountEmail: null,
        externalAccountId: portal,
        metadata: { portalId: portal, accountType: info.accountType ?? null, timeZone: info.timeZone ?? null, uiDomain: info.uiDomain ?? null },
      };
    } catch (error) {
      // A dead grant must fail the connect; anything else only costs us the label.
      if (error instanceof NangoError && error.kind === 'REAUTH') throw error;
      this.logger.warn(`Could not read HubSpot account details: ${(error as Error).message}`);
      return { accountName: null, accountEmail: null, externalAccountId: null };
    }
  }

  async validateConnection(ctx: AdapterContext): Promise<boolean> {
    try {
      await ctx.client.get('/crm/v3/objects/contacts', { limit: 1, archived: 'false' });
      return true;
    } catch (error) {
      if (error instanceof NangoError && error.kind === 'REAUTH') return false;
      throw error;
    }
  }

  /** Optional: which HubSpot properties hold budget, bedrooms, timeline... Contacts import without it. */
  readonly setup: AdapterSetup = {
    resourceKinds: ['properties'],

    state: (settings): SetupState => {
      const mapped = Object.keys(readPropertyMap(settings)).length;
      return { complete: true, missing: null, summary: mapped ? `Contacts · ${mapped} extra field${mapped === 1 ? '' : 's'} mapped` : 'Contacts' };
    },

    listResources: async (ctx, kind): Promise<SetupResource[]> => {
      if (kind !== 'properties') throw new AppError('VALIDATION_ERROR', `HubSpot has no "${kind}" to list.`);
      const properties = await this.properties(ctx);
      return properties
        .filter((p) => MAPPABLE_TARGETS.some((t) => mappable(p, t)))
        .map((p) => ({
          id: p.name,
          name: p.label || p.name,
          detail: { type: p.type ?? null, fieldType: p.fieldType ?? null, targets: MAPPABLE_TARGETS.filter((t) => mappable(p, t)) },
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    saveSettings: async (ctx, input) => {
      const requested = input.propertyMap && typeof input.propertyMap === 'object' && !Array.isArray(input.propertyMap) ? (input.propertyMap as Record<string, unknown>) : {};
      const properties = new Map((await this.properties(ctx)).map((p) => [p.name, p]));
      const propertyMap: PropertyMap = {};
      const used = new Set<string>();
      for (const [target, name] of Object.entries(requested)) {
        if (name === null || name === undefined || name === '') continue;
        if (!(MAPPABLE_TARGETS as readonly string[]).includes(target)) throw new AppError('VALIDATION_ERROR', `Unknown lead field "${target}".`);
        if (typeof name !== 'string' || !PROPERTY_NAME.test(name)) throw new AppError('VALIDATION_ERROR', `Choose a HubSpot property for ${target}.`);
        const property = properties.get(name);
        if (!property) throw new AppError('VALIDATION_ERROR', `The HubSpot property "${name}" does not exist in this portal.`);
        if (!mappable(property, target as MappableTarget)) {
          throw new AppError('VALIDATION_ERROR', `"${property.label ?? name}" cannot hold ${target}: it is read-only or of the wrong type.`);
        }
        if (used.has(name)) throw new AppError('VALIDATION_ERROR', `"${property.label ?? name}" is mapped twice. Use each property once.`);
        used.add(name);
        propertyMap[target as MappableTarget] = name;
      }
      return { propertyMap };
    },
  };

  readonly import: AdapterImport<Cursor> = {
    sourceName: () => 'HubSpot contacts',

    fetchPage: async (ctx, cursor): Promise<ImportPage<Cursor>> => {
      const map = readPropertyMap(ctx.settings);
      const properties = [...new Set([...BASE_PROPERTIES, ...Object.values(map)])];
      const page = await ctx.client.get<{ results?: HubSpotContact[]; paging?: { next?: { after?: string } } }>(
        '/crm/v3/objects/contacts',
        {
          limit: PAGE_SIZE,
          archived: 'false',
          properties: properties.join(','),
          ...(cursor ? { after: cursor.after } : {}),
        },
      );
      const after = page.paging?.next?.after;
      return { records: (page.results ?? []).map((c) => contactToRecord(c, map)), next: after ? { after } : null };
    },
  };

  readonly writeBack: AdapterWriteBack = {
    writeScopes: ['crm.objects.contacts.write'],

    fields: (settings) => {
      const map = readPropertyMap(settings);
      // Location without a mapped property is city/state/country joined: read, never written.
      return ['firstName', 'lastName', 'email', 'phone', 'motivation', 'location', ...(Object.keys(map) as SyncField[])].filter(
        (f, i, all) => all.indexOf(f) === i,
      ) as SyncField[];
    },

    writableFields: async (ctx) => {
      const map = readPropertyMap(ctx.settings);
      const out: SyncField[] = ['firstName', 'lastName', 'email', 'phone', 'motivation'];
      for (const target of Object.keys(map) as MappableTarget[]) if (!out.includes(target)) out.push(target);
      return out;
    },

    push: async (ctx, target, changes) => {
      if (target.objectType !== 'hubspot:contact') throw new WriteRefused('Only HubSpot contacts are written back.');
      if (!/^\d{1,30}$/.test(target.externalId)) throw new WriteRefused('This HubSpot contact id is not valid.');
      const map = readPropertyMap(ctx.settings);
      const properties: Record<string, string> = {};
      for (const [field, value] of Object.entries(changes) as [SyncField, SyncValue][]) {
        const name =
          field === 'phone'
            ? target.meta.phoneProperty === 'mobilephone'
              ? 'mobilephone'
              : 'phone'
            : (map[field as MappableTarget] ?? STANDARD[field]);
        if (!name) continue;
        // HubSpot clears a property set to an empty string.
        properties[name] = value === null ? '' : String(value);
      }
      if (!Object.keys(properties).length) return;
      await ctx.client.patch(`/crm/v3/objects/contacts/${target.externalId}`, { properties });
    },
  };

  private async properties(ctx: AdapterContext): Promise<HubSpotProperty[]> {
    const res = await ctx.client.get<{ results?: HubSpotProperty[] }>('/crm/v3/properties/contacts', { archived: 'false' });
    return (res.results ?? []).filter((p) => typeof p.name === 'string');
  }
}
