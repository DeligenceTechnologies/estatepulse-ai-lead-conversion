import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOOKING_PROMPT_START } from '../modules/calendar/in-call-booking/booking-prompt';
import { AssistantService } from './assistant.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const OFFICE = '# Role\nYou are the assistant for Austin Homes.';

function setup(bookingOn: boolean) {
  const creds: any = { getCreds: vi.fn().mockResolvedValue({ apiKey: 'KEY', assistantId: 'asst-1' }) };
  const prisma: any = {
    integrations: {
      findFirst: vi
        .fn()
        .mockResolvedValue(bookingOn ? { metadata: { eventTypeName: 'Buyer Consultation', durationMinutes: 30 } } : null),
    },
  };
  const sent: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: any) => {
      if (init?.method === 'PATCH') sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'asst-1', instructions: OFFICE }), { status: 200 });
    }),
  );
  return { svc: new AssistantService(creds, prisma), sent };
}

afterEach(() => vi.unstubAllGlobals());

describe('AssistantService.updateAssistant — the in-call booking section', () => {
  it('keeps the booking section when an older copy of the prompt is saved while booking is on', async () => {
    const { svc, sent } = setup(true);
    await svc.updateAssistant('org-1', { instructions: OFFICE });
    expect(sent[0].instructions.startsWith(OFFICE + '\n\n' + BOOKING_PROMPT_START)).toBe(true);
    expect(sent[0].instructions).toContain('"Buyer Consultation"');
  });

  it('never duplicates it when the saved prompt already has it', async () => {
    const { svc, sent } = setup(true);
    await svc.updateAssistant('org-1', { instructions: OFFICE });
    await svc.updateAssistant('org-1', { instructions: sent[0].instructions });
    expect(sent[1].instructions.split(BOOKING_PROMPT_START)).toHaveLength(2);
  });

  it('saves the prompt exactly as given when booking is off', async () => {
    const { svc, sent } = setup(false);
    await svc.updateAssistant('org-1', { instructions: OFFICE });
    expect(sent[0].instructions).toBe(OFFICE);
  });
});
