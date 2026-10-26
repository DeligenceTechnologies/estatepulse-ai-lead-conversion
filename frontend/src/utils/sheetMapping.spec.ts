import { describe, expect, it } from 'vitest';
import { approveMessage, choicesFromColumns, columnsFromChoices, draftProblems, rejectMessage } from './sheetMapping';

describe('sheet mapping choices', () => {
  it('round-trips a budget range and a full name through the API pairs', () => {
    const columns = columnsFromChoices({ budget: 'budget_range', name: 'full_name', phone: 'phone', skip: '' });
    expect(columns).toEqual([
      { fieldKey: 'budget', target: 'min_budget' },
      { fieldKey: 'budget', target: 'max_budget' },
      { fieldKey: 'name', target: 'full_name' },
      { fieldKey: 'phone', target: 'phone' },
    ]);
    expect(choicesFromColumns(columns)).toEqual({ budget: 'budget_range', name: 'full_name', phone: 'phone' });
  });

  it('blocks saving without a name, a contact, or an acknowledged fallback', () => {
    expect(draftProblems({ email: 'email' }, { mode: 'column', fieldKey: 'id' }, false)).toEqual([
      'Choose the column with the lead’s name.',
    ]);
    expect(draftProblems({ name: 'full_name' }, { mode: 'column', fieldKey: 'id' }, false)).toEqual([
      'Choose a phone or an email column.',
    ]);
    const ok = { name: 'full_name', phone: 'phone' } as const;
    expect(draftProblems(ok, { mode: 'fallback' }, false)).toHaveLength(1);
    expect(draftProblems(ok, { mode: 'fallback' }, true)).toEqual([]);
    expect(draftProblems(ok, { mode: 'column', fieldKey: '' }, false)).toEqual(['Choose the ID column.']);
  });

  it('refuses one field filled from two columns', () => {
    const p = draftProblems({ a: 'full_name', b: 'first_name', c: 'phone' }, { mode: 'column', fieldKey: 'a' }, false);
    expect(p).toEqual(['First name is filled from more than one column.']);
  });
});

describe('decision messages', () => {
  it('says how many approved leads were released and why the rest stay paused', () => {
    const text = approveMessage({
      approved: 3,
      released: 1,
      held: [
        { rowId: 'r2', leadId: 'l2', reason: 'DO_NOT_CONTACT' },
        { rowId: 'r3', leadId: 'l3', reason: 'NO_DIALABLE_PHONE' },
      ],
      skipped: ['r4'],
    });
    expect(text).toBe(
      'Approved 3 leads. 1 lead is now eligible for your outreach strategy. 2 stay paused (1 do-not-contact, 1 no phone that can be dialled). 1 row was already decided.',
    );
    expect(approveMessage({ approved: 0, released: 0, held: [], skipped: ['r1'] })).toMatch(/^Nothing approved/);
  });

  it('reports rejections as closed and never contacted', () => {
    expect(rejectMessage({ rejected: 2, skipped: [] })).toBe('Rejected 2 leads: closed, and never contacted.');
  });
});
