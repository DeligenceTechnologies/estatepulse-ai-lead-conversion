import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Metadata, getCountries, getCountryCallingCode } from 'libphonenumber-js';
import { LeadStatus } from '../../common/domain';
import { AppError } from '../../common/errors';
import { newId } from '../../common/ids';
import { TENANT_PRISMA, type GuardedPrisma } from '../../prisma/prisma.service';
import { EventsBus } from '../events/events.bus';
import { DNC_REASON, contactFlags, leadColumns } from '../google-sheets/sheet-import.service';
import { buildRow, expandMapping, type ColumnMapping } from '../google-sheets/sheet-rows';

/**
 * Told to the owner, not written on the lead: the lead is eligible, the office
 * just has no line yet. The watcher picks it up the moment Telnyx is connected.
 */
export const NOT_CONNECTED_NOTE =
  'Telnyx is not connected, so nobody is contacted yet. Once it is connected under Integrations, the AI reaches out to this lead.';

/** The one lead_source every lead typed in by hand belongs to; created on first use. */
export const MANUAL_SOURCE_CODE = 'manual';
export const MANUAL_PROVIDER = 'MANUAL';
export const MANUAL_CONNECTION = 'MANUAL';

export interface ManualLeadInput {
  firstName: string;
  lastName?: string;
  phone: string;
  email?: string;
  location?: string;
  /** Free text, as a form or sheet would carry it: "$500k – 700k", "under 600k". */
  budget?: string;
  bedrooms?: string;
  motivation?: string;
  /** ISO 3166-1 alpha-2, already checked against libphonenumber. Absent: the organization's default. */
  region?: string;
}

export interface RegionsDTO {
  /** The organization's own region: what the picker starts on. */
  default: string;
  /** One entry per calling code; `countries` has the code's main country first ("+44": GB, then GG, IM, JE). */
  codes: { callingCode: string; countries: string[] }[];
}

/**
 * Which country a shared calling code means by default (+1 is the US before
 * Anguilla). The library knows but does not type it; the fallback groups the
 * typed API's countries with no main-country order.
 */
function callingCodeGroups(): Record<string, string[]> {
  const metadata = new Metadata() as unknown as { countryCallingCodes?: () => Record<string, string[]> };
  if (typeof metadata.countryCallingCodes === 'function') return metadata.countryCallingCodes();
  const groups: Record<string, string[]> = {};
  for (const code of getCountries()) (groups[getCountryCallingCode(code)] ??= []).push(code);
  return groups;
}

export interface ManualLeadResultDTO {
  id: string;
  /** The AI reaches out: nothing holds the lead (no opt-out, a dialable phone). */
  contacting: boolean;
  /** What the owner should know before anyone calls: a possible duplicate, an earlier opt-out, a phone we could not read. */
  warnings: string[];
}

/**
 * The form's fields as one "row": the same transforms, validation and
 * review flags a sheet or file row goes through (buildRow), so a lead reads
 * identically whichever way it arrived. One budget field feeds min AND max,
 * exactly as one budget column does.
 */
const FIELDS = ['first_name', 'last_name', 'phone', 'email', 'location', 'budget', 'bedrooms', 'motivation'] as const;
const LABELS: Record<(typeof FIELDS)[number], string> = {
  first_name: 'First name',
  last_name: 'Last name',
  phone: 'Phone',
  email: 'Email',
  location: 'Area',
  budget: 'Budget',
  bedrooms: 'Bedrooms',
  motivation: 'Notes',
};
const COLUMNS: ColumnMapping[] = [
  { fieldKey: 'first_name', target: 'first_name' },
  { fieldKey: 'last_name', target: 'last_name' },
  { fieldKey: 'phone', target: 'phone' },
  { fieldKey: 'email', target: 'email' },
  { fieldKey: 'location', target: 'location' },
  { fieldKey: 'budget', target: 'min_budget' },
  { fieldKey: 'budget', target: 'max_budget' },
  { fieldKey: 'bedrooms', target: 'bedrooms' },
  { fieldKey: 'motivation', target: 'motivation' },
];
const HEADER_INDEX = new Map(FIELDS.map((f, i) => [f, i] as const));
const HEADER_LABELS = new Map(Object.entries(LABELS));

@Injectable()
export class ManualLeadService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly events: EventsBus,
  ) {}

  /**
   * One lead, typed in by the owner. Saved like an approved import row: the
   * owner's "Add" is the approval, so the watcher starts outreach unless an
   * earlier opt-out holds it — the same hold approval respects. A number the
   * AI cannot dial is refused outright (the owner is right there to fix it),
   * where an import would keep the row paused. A duplicate contact is flagged,
   * never refused: each submission stays its own lead, as everywhere else.
   */
  async regions(organizationId: string): Promise<RegionsDTO> {
    return {
      default: await this.orgRegion(organizationId),
      codes: Object.entries(callingCodeGroups())
        .map(([callingCode, countries]) => ({ callingCode, countries }))
        .sort((a, b) => Number(a.callingCode) - Number(b.callingCode)),
    };
  }

  private async orgRegion(organizationId: string): Promise<string> {
    const org = await this.prisma.organizations.findUnique({ where: { id: organizationId }, select: { default_region: true } });
    return org?.default_region ?? 'US';
  }

  async create(organizationId: string, userId: string, input: ManualLeadInput): Promise<ManualLeadResultDTO> {
    const region = input.region ?? (await this.orgRegion(organizationId));
    const cells = [
      input.firstName,
      input.lastName ?? '',
      input.phone ?? '',
      input.email ?? '',
      input.location ?? '',
      input.budget ?? '',
      input.bedrooms ?? '',
      input.motivation ?? '',
    ];
    const row = buildRow(cells, 1, {
      headerIndex: HEADER_INDEX,
      labels: HEADER_LABELS,
      mappings: expandMapping(COLUMNS, region),
      identity: { mode: 'fallback' },
      region,
    });
    // The schema already requires a name and a phone; what is left to refuse is a phone that does not parse.
    if (!row.lead?.normalized_phone) {
      throw new AppError('VALIDATION_ERROR', 'Invalid lead details', [
        { path: 'phone', message: 'Enter a phone number that can be dialled, with its country code' },
      ]);
    }

    const source = await this.manualSource(organizationId);
    const flags = await contactFlags(this.prisma, organizationId, [row]);
    const reasons = [...(flags.reasons.get(row.rowNumber) ?? []), ...row.reviewReasons];
    const dnc = reasons.includes(DNC_REASON);
    // The one hold on the lead itself, the same one approveTrackingRows respects: an earlier opt-out.
    // Beyond that, outreach needs a line: the same row the lead watcher polls for.
    const connected = Boolean(
      await this.prisma.integrations.findFirst({ where: { organization_id: organizationId, provider: 'telnyx', status: 'active' }, select: { id: true } }),
    );
    const contacting = !dnc && connected;

    const leadId = newId();
    await this.prisma.$transaction(async (tx) => {
      await tx.leads.create({
        data: {
          id: leadId,
          organization_id: organizationId,
          lead_source_id: source.id,
          ...leadColumns(row.lead!, null),
          status: LeadStatus.NEW,
          // Only an opt-out pauses the lead. Without a line it stays eligible, so connecting Telnyx later starts it.
          automation_paused: dnc,
          dnc_status: dnc,
          needs_review: reasons.length > 0,
          review_reasons: reasons,
          consent_status: source.default_consent_status,
        },
      });
      await tx.audit_logs.create({
        data: {
          id: newId(),
          organization_id: organizationId,
          actor_type: 'user',
          actor_id: userId,
          action: 'lead.added_by_hand',
          entity_type: 'lead',
          entity_id: leadId,
          payload: { contacting, warnings: reasons } as Prisma.InputJsonValue,
        },
      });
    });
    this.events.publish({ organizationId, type: 'lead.created', leadSourceId: source.id });
    return { id: leadId, contacting, warnings: [...reasons, ...(!dnc && !connected ? [NOT_CONNECTED_NOTE] : [])] };
  }

  private async manualSource(organizationId: string): Promise<{ id: string; default_consent_status: string }> {
    const where = { organization_id: organizationId, code: MANUAL_SOURCE_CODE };
    const select = { id: true, default_consent_status: true } as const;
    const found = await this.prisma.lead_sources.findFirst({ where, select });
    if (found) return found;
    try {
      return await this.prisma.lead_sources.create({
        data: {
          organization_id: organizationId,
          name: 'Manually added',
          code: MANUAL_SOURCE_CODE,
          source_type: 'manual',
          provider: MANUAL_PROVIDER,
          connection_method: MANUAL_CONNECTION,
          is_active: true,
          default_consent_status: 'pending',
        },
        select,
      });
    } catch (e) {
      // Two first leads at once: lead_sources_code_unique let one in.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      const again = await this.prisma.lead_sources.findFirst({ where, select });
      if (!again) throw e;
      return again;
    }
  }
}
