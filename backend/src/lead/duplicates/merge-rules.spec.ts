import { ConsentStatus, LeadStatus, Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { type MergeLead, combineNotes, fillBlanks, mergeAnswers, pickSurvivor, resolveMerge, restoreFromSnapshot, snapshotForUndo } from './merge-rules';

const base = (over: Partial<MergeLead>): MergeLead =>
  ({
    id: 'x',
    orgId: 'org',
    leadSourceId: null,
    createdAt: new Date('2026-01-01'),
    status: LeadStatus.new,
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    normalizedEmail: null,
    normalizedPhone: null,
    emailValid: false,
    phoneValid: false,
    externalLeadId: null,
    timezone: null,
    location: null,
    timeline: null,
    buyingIntent: null,
    financingStatus: null,
    minBudget: null,
    maxBudget: null,
    bedrooms: null,
    motivation: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    customFields: {},
    qualificationAnswers: {},
    memorySummary: null,
    memoryUpdatedAt: null,
    aiSummary: null,
    consentStatus: ConsentStatus.pending,
    consentSource: null,
    consentAt: null,
    dncStatus: false,
    automationPaused: false,
    needsReview: false,
    reviewReasons: [],
    assignedToId: null,
    assignedAt: null,
    assignmentType: null,
    callbackAt: null,
    textBackAt: null,
    firstContactAt: null,
    firstResponseAt: null,
    lastContactAt: null,
    submissionCount: 1,
    lastSubmissionAt: null,
    mergedIntoId: null,
    ...over,
  }) as MergeLead;

describe('fillBlanks', () => {
  it('fills only what the lead lacks, never overwrites', () => {
    expect(fillBlanks({ firstName: 'Ana', location: '' }, { firstName: 'Anna', location: 'Austin', timeline: '3 months' })).toEqual({
      location: 'Austin',
      timeline: '3 months',
    });
  });
});

describe('mergeAnswers', () => {
  it('a manual answer beats an AI one; otherwise the newer wins', () => {
    const a = { budget: { value: '500k', at: '2026-02-01', source: 'manual' }, beds: { value: 2, at: '2026-01-01', source: 'call' } };
    const b = { budget: { value: '700k', at: '2026-03-01', source: 'sms' }, beds: { value: 3, at: '2026-02-01', source: 'sms' }, pets: { value: 'dog' } };
    expect(mergeAnswers(a, b)).toEqual({ budget: a.budget, beds: b.beds, pets: b.pets });
  });
});

describe('pickSurvivor', () => {
  const at = new Date('2026-01-01');
  it('keeps the lead furthest along, then the busier, then the older', () => {
    expect(pickSurvivor({ id: 'a', status: LeadStatus.new, createdAt: at, activity: 9 }, { id: 'b', status: LeadStatus.appointment_booked, createdAt: at, activity: 0 }).survivor).toBe('b');
    expect(pickSurvivor({ id: 'a', status: LeadStatus.new, createdAt: at, activity: 1 }, { id: 'b', status: LeadStatus.new, createdAt: at, activity: 4 }).survivor).toBe('b');
    expect(pickSurvivor({ id: 'a', status: LeadStatus.new, createdAt: new Date('2026-02-01'), activity: 0 }, { id: 'b', status: LeadStatus.new, createdAt: at, activity: 0 }).survivor).toBe('b');
  });
});

describe('resolveMerge', () => {
  const survivor = base({
    id: 's',
    leadSourceId: 'src-new',
    createdAt: new Date('2026-03-01'),
    firstName: 'Ana',
    phone: '+15125550188',
    normalizedPhone: '+15125550188',
    phoneValid: true,
    consentStatus: ConsentStatus.granted,
    firstContactAt: new Date('2026-03-02'),
    lastContactAt: new Date('2026-03-05'),
    submissionCount: 2,
    reviewReasons: ['Possible duplicate: another lead has the same phone or email', 'Phone: x'],
    customFields: { a: 1 },
    memorySummary: 'Wants a yard.',
  });
  const merged = base({
    id: 'm',
    leadSourceId: 'src-original',
    createdAt: new Date('2026-01-01'),
    firstName: 'Anna',
    email: 'ana@example.com',
    normalizedEmail: 'ana@example.com',
    emailValid: true,
    location: 'Austin',
    minBudget: new Prisma.Decimal(400000),
    consentStatus: ConsentStatus.revoked,
    dncStatus: true,
    firstContactAt: new Date('2026-01-02'),
    lastContactAt: new Date('2026-01-10'),
    submissionCount: 1,
    customFields: { a: 2, b: 3 },
    memorySummary: 'Pre-approved.',
  });
  const out = resolveMerge(survivor, merged);

  it("keeps the survivor's values and fills its blanks from the other lead", () => {
    expect(out.firstName).toBeUndefined();
    expect(out).toMatchObject({ email: 'ana@example.com', normalizedEmail: 'ana@example.com', emailValid: true, location: 'Austin' });
  });
  it('keeps the source the person first came from', () => {
    expect(out.leadSourceId).toBe('src-original');
  });
  it('takes the safer side of consent and do-not-contact', () => {
    expect(out).toMatchObject({ consentStatus: ConsentStatus.revoked, dncStatus: true, automationPaused: true });
  });
  it('widens the history dates and adds up submissions', () => {
    expect(out).toMatchObject({ firstContactAt: merged.firstContactAt, lastContactAt: survivor.lastContactAt, submissionCount: 3 });
  });
  it('answers the possible-duplicate note and keeps the others', () => {
    expect(out.reviewReasons).toEqual(['Phone: x']);
  });
  it('unions custom fields (survivor wins) and joins memory notes', () => {
    expect(out.customFields).toEqual({ a: 1, b: 3 });
    expect(out.memorySummary).toBe('Wants a yard.\nPre-approved.');
  });
  it('undo restores exactly the columns the merge changed, dates as dates, status never', () => {
    const snap = snapshotForUndo(survivor, { ...out, status: LeadStatus.closed });
    expect(Object.keys(snap)).not.toContain('firstName');
    const back = restoreFromSnapshot(snap);
    expect(back).toMatchObject({ email: null, location: null, leadSourceId: 'src-new', submissionCount: 2, consentStatus: ConsentStatus.granted });
    expect(back.firstContactAt).toEqual(survivor.firstContactAt);
    expect(back).not.toHaveProperty('status');
  });
});

describe('combineNotes', () => {
  it('one note stays as it is; two are joined within the limit', () => {
    expect(combineNotes(null, 'b')).toBe('b');
    expect(combineNotes('a'.repeat(10), 'b'.repeat(10), 15)).toHaveLength(15);
  });
});
