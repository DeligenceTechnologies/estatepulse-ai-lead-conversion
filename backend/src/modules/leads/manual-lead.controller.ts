import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { isSupportedCountry } from 'libphonenumber-js';
import { z } from 'zod';
import type { AuthContext } from '../../auth/types';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import { OwnerGuard } from '../../common/guards/owner.guard';
import { SessionGuard } from '../../common/guards/session.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ManualLeadService, type ManualLeadInput, type ManualLeadResultDTO, type RegionsDTO } from './manual-lead.service';

/**
 * Strict, like every write body here. A name and a phone are required — the
 * AI reaches out by call and text, so a lead without a number is not one it
 * can work; everything else is optional and arrives as typed. The service
 * normalises it through the same transforms an import uses, and refuses a
 * number it cannot dial.
 */
const text = (max: number) => z.string().trim().max(max).optional();
const createLeadSchema = z
  .object({
    firstName: z.string().trim().min(1, 'First name is required').max(100),
    lastName: text(100),
    phone: z.string().trim().min(1, 'Phone number is required').max(50),
    email: text(255),
    location: text(255),
    budget: text(100),
    bedrooms: text(10),
    motivation: text(2000),
    /**
     * The country a local phone number is read in (ISO 3166-1 alpha-2), for a
     * lead outside the office's own region. A number typed with its + code
     * needs none. Absent: the organization's default region.
     */
    region: z
      .string()
      .trim()
      .toUpperCase()
      .refine((c) => isSupportedCountry(c), 'Unknown country')
      .optional(),
  })
  .strict();

/**
 * Owner-only: one lead typed in by hand. A separate controller from
 * LeadsController because that one is read-only by design and accepts API
 * keys; writing a lead needs a signed-in owner, like a file import does.
 */
@Controller('api/v1/leads')
@UseGuards(SessionGuard, OwnerGuard)
export class ManualLeadController {
  constructor(private readonly leads: ManualLeadService) {}

  /** The countries a local number can be read in, and the office's own. For the form's country picker. */
  @Get('regions')
  regions(@CurrentUser() auth: AuthContext): Promise<RegionsDTO> {
    return this.leads.regions(auth.organizationId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(createLeadSchema, 'Invalid lead details')) body: ManualLeadInput,
  ): Promise<ManualLeadResultDTO> {
    return this.leads.create(auth.organizationId, auth.userId, body);
  }
}
