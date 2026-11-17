import { BadRequestException } from '@nestjs/common';
import { normalizePhone } from '@/telnyx/phone';
import { cleanServiceAreas } from '@/transfer/live-transfer';

/** Every member has a phone that can be dialed: a country code and at least 8 digits. */
export function assertMemberPhone(phone: string | null | undefined): void {
  const raw = (phone ?? '').trim();
  if (!raw.startsWith('+') || normalizePhone(raw).length < 8) {
    throw new BadRequestException('Add a phone number with its country code (e.g. +1 512 555 0100).');
  }
}

/** Every member covers at least one ZIP code or city. */
export function assertMemberAreas(areas: readonly string[] | null | undefined): void {
  if (!cleanServiceAreas(areas ?? []).length) {
    throw new BadRequestException('Add at least one area (ZIP code or city) they cover.');
  }
}
