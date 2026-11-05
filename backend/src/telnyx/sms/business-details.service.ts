import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { TelnyxCredentialsService } from '../telnyx-credentials.service';
import { businessDetails, businessDetailsComplete, type BusinessDetails } from './sms-compliance';

export interface BusinessDetailsView extends BusinessDetails {
  /** The mailing address is there, so a Canadian lead's HELP answer says in full who is texting. */
  complete: boolean;
  /** For the editors' preview: what {{brokerage}} becomes, and the number texts go out from. */
  brokerage: string;
  ourNumber: string | null;
}

/**
 * Who the organization is in its texts: the one place it is set (AI Settings).
 * Outreach texts to Canada name the brokerage and our number; the HELP answer
 * adds the mailing address and the email or website.
 */
@Injectable()
export class BusinessDetailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: TelnyxCredentialsService,
  ) {}

  async view(orgId: string): Promise<BusinessDetailsView> {
    const [org, row, c] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
      this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { businessDetails: true } }),
      this.creds.getCreds(orgId).catch(() => null),
    ]);
    const details = businessDetails(row?.businessDetails);
    return { ...details, complete: businessDetailsComplete(details), brokerage: org?.name?.trim() || 'our team', ourNumber: c?.fromNumber || null };
  }

  /** Only the fields the patch sets change; an empty one clears it. */
  async update(orgId: string, patch: Partial<BusinessDetails>): Promise<BusinessDetailsView> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { businessDetails: true } });
    const set = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const next = businessDetails({ ...businessDetails(row?.businessDetails), ...set });
    const stored = { ...next };
    await this.prisma.organizationSetting.upsert({ where: { orgId }, create: { orgId, businessDetails: stored }, update: { businessDetails: stored } });
    return this.view(orgId);
  }
}
