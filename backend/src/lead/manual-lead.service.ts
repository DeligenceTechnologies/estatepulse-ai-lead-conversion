import { Injectable } from '@nestjs/common';
import { ConsentStatus, LeadStatus, LeadTemperature } from '@prisma/client';
import parsePhoneNumberFromString from 'libphonenumber-js';
import { AuditService } from '@/audit/audit.service';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { EventsBus } from '@/events/events.bus';
import { CONSENT_REVIEW_REASON } from './consent';
import type { CreateLeadDto } from './dto/create-lead.dto';
import { DUPLICATE_REASON } from './duplicates/duplicate-reasons';
import { normalizeEmail } from './duplicates/identity';
import { DuplicateScannerService } from './duplicates/duplicate-scanner.service';
import { LeadIntakeService } from './duplicates/lead-intake.service';

const DNC_REASON = 'This phone or email is on the do-not-contact list from an earlier lead';

/**
 * One lead an owner types in by hand on the Leads screen. It has no lead source and joins the
 * same pipeline as a form submission: status `new`, so the lead watcher enrolls it in the
 * strategy unless paused. Without its consent box ticked it is held, paused, in Import Review
 * until the owner records the consent or rejects it (ConsentReviewService). A phone or email that
 * is already a lead's does not make a second lead: the entry is attached to that lead
 * (LeadIntakeService — blanks filled, nothing overwritten) and the answer says so.
 */
@Injectable()
export class ManualLeadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsBus,
    private readonly intake: LeadIntakeService,
    private readonly scanner: DuplicateScannerService,
  ) {}

  async create(orgId: string, userId: string, input: CreateLeadDto): Promise<{ id: string; matchedBy: 'phone' | 'email' | null }> {
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
    const normalizedEmail = normalizeEmail(input.email);

    // Someone who asked not to be contacted stays that way, however they come back in.
    const dnc =
      (await this.prisma.lead.count({
        where: {
          orgId,
          dncStatus: true,
          OR: [
            ...(normalizedPhone ? [{ normalizedPhone }] : []),
            ...(normalizedEmail ? [{ normalizedEmail }] : []),
          ],
        },
      })) > 0;

    const awaitingConsent = !input.consent && !dnc;
    const reviewReasons = [...(dnc ? [DNC_REASON] : []), ...(awaitingConsent ? [CONSENT_REVIEW_REASON] : [])];
    const now = new Date();
    const result = await this.intake.intake(
      {
        orgId,
        leadSourceId: null,
        channel: 'manual',
        normalizedPhone,
        normalizedEmail,
        values: {
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          timezone: input.timezone,
          location: input.location,
          timeline: input.timeline,
          minBudget: input.minBudget,
          maxBudget: input.maxBudget,
          bedrooms: input.bedrooms,
          motivation: input.notes,
        },
        submittedAt: now,
        actor: { type: 'user', id: userId },
      },
      async (tx, conflictWith) => {
        const reasons = conflictWith.length ? [...reviewReasons, DUPLICATE_REASON] : reviewReasons;
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
            consentAt: input.consent ? now : null,
            dncStatus: dnc,
            // Outreach needs the consent box: without it the lead is held for review, whatever startOutreach says.
            automationPaused: dnc || !input.startOutreach || !input.consent || conflictWith.length > 0,
            needsReview: reasons.length > 0,
            reviewReasons: reasons,
            lastSubmissionAt: now,
          },
          select: { id: true },
        });
        return created.id;
      },
    );
    const attached = result.matchedBy !== null;
    await this.audit.record({
      orgId,
      actorType: 'user',
      actorId: userId,
      action: attached ? 'lead.resubmitted' : 'lead.created',
      entityType: 'lead',
      entityId: result.leadId,
      payload: attached
        ? { source: 'manual', matchedBy: result.matchedBy }
        : { source: 'manual', startOutreach: input.startOutreach && input.consent && !dnc, awaitingConsent },
    });

    if (attached) {
      this.events.publish({ organizationId: orgId, type: 'lead.updated', leadSourceId: null, leadId: result.leadId });
      return { id: result.leadId, matchedBy: result.matchedBy };
    }
    this.scanner.scanLeadQuietly(orgId, result.leadId);
    this.events.publish({ organizationId: orgId, type: 'lead.created', leadSourceId: null });
    return { id: result.leadId, matchedBy: null };
  }
}
