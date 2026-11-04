import { Injectable } from '@nestjs/common';
import { ConsentStatus, LeadStatus, LeadTemperature, Prisma } from '@prisma/client';
import parsePhoneNumberFromString from 'libphonenumber-js';
import { AuditService } from '@/audit/audit.service';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { EventsBus } from '@/events/events.bus';
import { PHONE_UNPARSED_REASON } from '@/google-sheets/sheet-rows';
import type { CreateLeadDto } from './dto/create-lead.dto';
import type { UpdateLeadDto } from './dto/update-lead.dto';

const DNC_REASON = 'This phone or email is on the do-not-contact list from an earlier lead';

/**
 * Leads an owner works on by hand on the Leads screen: one typed in, and one corrected
 * afterwards. A lead typed in has no lead source and joins the same pipeline as a form
 * submission: status `new`, so the lead watcher enrolls it in the strategy unless paused.
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

  /**
   * Corrects an existing lead, whatever it came from. The reason this exists: a lead imported
   * with a phone number that carried no country code is kept but cannot be dialled, and the
   * sheet it came from is not always the owner’s to edit. Putting the country code in here
   * clears that flag and lets outreach reach them.
   *
   * Only the keys sent are touched; "" clears a text field.
   */
  async update(orgId: string, userId: string, leadId: string, input: UpdateLeadDto): Promise<{ id: string }> {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, orgId },
      select: {
        id: true,
        phone: true,
        email: true,
        normalizedPhone: true,
        normalizedEmail: true,
        dncStatus: true,
        reviewReasons: true,
      },
    });
    if (!lead) throw new AppError('NOT_FOUND', 'That lead no longer exists.');

    const data: Prisma.LeadUpdateInput = {};
    const changed: string[] = [];

    // A phone is only stored once it can actually be rung. No country is assumed from the
    // digits — the same ten digits are a valid number in dozens of countries — so a number
    // without its code is refused here, where there is a person who can add it.
    let normalizedPhone = lead.normalizedPhone;
    if (input.phone !== undefined) {
      if (input.phone === '') {
        normalizedPhone = null;
        Object.assign(data, { phone: null, normalizedPhone: null, phoneValid: false });
      } else {
        const parsed = parsePhoneNumberFromString(input.phone);
        if (!parsed?.isValid()) {
          throw new AppError(
            'VALIDATION_ERROR',
            `"${input.phone}" is not a phone number we can dial. Start with the country code, e.g. +91 98765 43210.`,
          );
        }
        normalizedPhone = parsed.number;
        Object.assign(data, { phone: input.phone, normalizedPhone, phoneValid: true });
      }
      changed.push('phone');
    }

    let normalizedEmail = lead.normalizedEmail;
    if (input.email !== undefined) {
      normalizedEmail = input.email === '' ? null : input.email.toLowerCase();
      Object.assign(data, { email: input.email || null, normalizedEmail, emailValid: Boolean(normalizedEmail) });
      changed.push('email');
    }

    if (!normalizedPhone && !normalizedEmail) {
      throw new AppError('VALIDATION_ERROR', 'A lead needs a phone number or an email address.');
    }

    for (const key of ['firstName', 'lastName', 'location', 'timeline'] as const) {
      if (input[key] === undefined) continue;
      Object.assign(data, { [key]: input[key] || null });
      changed.push(key);
    }
    if (input.notes !== undefined) { Object.assign(data, { motivation: input.notes || null }); changed.push('notes'); }
    for (const key of ['minBudget', 'maxBudget', 'bedrooms'] as const) {
      if (input[key] === undefined) continue;
      Object.assign(data, { [key]: input[key] });
      changed.push(key);
    }

    const min = input.minBudget ?? undefined;
    const max = input.maxBudget ?? undefined;
    if (min !== undefined && max !== undefined && min > max) {
      throw new AppError('VALIDATION_ERROR', 'Budget min cannot be more than budget max.');
    }

    // Fixing the number is the whole point, so the flag it raised goes with it. Any other
    // reason the lead was held for stays: this corrected one field, not the whole review.
    if (normalizedPhone && lead.reviewReasons.includes(PHONE_UNPARSED_REASON)) {
      const left = lead.reviewReasons.filter((r) => r !== PHONE_UNPARSED_REASON);
      Object.assign(data, { reviewReasons: left, needsReview: left.length > 0 });
    }

    if (changed.length === 0) return { id: lead.id };

    await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: lead.id }, data });
      await this.audit.record(
        {
          orgId,
          actorType: 'user',
          actorId: userId,
          action: 'lead.updated',
          entityType: 'lead',
          entityId: lead.id,
          payload: { fields: changed },
        },
        tx,
      );
    });
    return { id: lead.id };
  }
}
