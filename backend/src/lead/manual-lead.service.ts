import { Injectable } from '@nestjs/common';
import { ConsentStatus, LeadStatus, LeadTemperature } from '@prisma/client';
import parsePhoneNumberFromString from 'libphonenumber-js';
import { AuditService } from '@/audit/audit.service';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { EventsBus } from '@/events/events.bus';
import { startsDoNotContact } from './contact-suppression';
import type { CreateLeadDto } from './dto/create-lead.dto';

const DNC_REASON = 'This phone or email is on the do-not-contact list from an earlier lead';

/**
 * One lead an owner types in by hand on the Leads screen. It has no lead source and joins the
 * same pipeline as a form submission: status `new`, so the lead watcher enrolls it in the
 * strategy unless paused. Nothing here edits a lead that already exists — an imported one is
 * corrected where it came from and synced again.
 */
@Injectable()
export class ManualLeadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsBus,
  ) {}

  async create(orgId: string, userId: string, input: CreateLeadDto): Promise<{ id: string }> {
    if (!input.phone && !input.email) {
      throw new AppError('VALIDATION_ERROR', 'Enter a phone number or an email address.');
    }
    if (input.minBudget !== undefined && input.maxBudget !== undefined && input.minBudget > input.maxBudget) {
      throw new AppError('VALIDATION_ERROR', 'Budget min cannot be more than budget max.');
    }

    let normalizedPhone: string | null = null;
    if (input.phone) {
      // No country is assumed from the digits: the same ten digits are a valid number in
      // dozens of countries, and a wrong guess is a lead nobody can reach. Here there is a
      // person at the form, so ask them for the code instead of flagging it for later.
      const parsed = parsePhoneNumberFromString(input.phone);
      if (!parsed?.isValid()) {
        throw new AppError(
          'VALIDATION_ERROR',
          `"${input.phone}" is not a phone number we can dial. Start with the country code, e.g. +91 98765 43210.`,
        );
      }
      normalizedPhone = parsed.number;
    }
    const normalizedEmail = input.email?.toLowerCase() ?? null;

    // Someone who asked not to be contacted stays that way, however they come back in.
    const dnc = await startsDoNotContact(this.prisma, orgId, normalizedPhone, normalizedEmail);

    const lead = await this.prisma.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          orgId,
          firstName: input.firstName,
          lastName: input.lastName ?? null,
          email: input.email ?? null,
          normalizedEmail,
          emailValid: Boolean(normalizedEmail),
          phone: input.phone ?? null,
          normalizedPhone,
          phoneValid: Boolean(normalizedPhone),
          timezone: input.timezone ?? null,
          status: LeadStatus.new,
          temperature: LeadTemperature.cold,
          score: 0,
          location: input.location ?? null,
          timeline: input.timeline ?? null,
          minBudget: input.minBudget ?? null,
          maxBudget: input.maxBudget ?? null,
          bedrooms: input.bedrooms ?? null,
          motivation: input.notes ?? null,
          consentStatus: input.consent ? ConsentStatus.granted : ConsentStatus.pending,
          consentSource: input.consent ? 'manual_entry' : null,
          consentAt: input.consent ? new Date() : null,
          dncStatus: dnc,
          automationPaused: dnc || !input.startOutreach,
          needsReview: dnc,
          reviewReasons: dnc ? [DNC_REASON] : [],
          lastSubmissionAt: new Date(),
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          orgId,
          actorType: 'user',
          actorId: userId,
          action: 'lead.created',
          entityType: 'lead',
          entityId: created.id,
          payload: { source: 'manual', startOutreach: input.startOutreach && !dnc },
        },
        tx,
      );
      return created;
    });

    this.events.publish({ organizationId: orgId, type: 'lead.created', leadSourceId: null });
    return lead;
  }
}
