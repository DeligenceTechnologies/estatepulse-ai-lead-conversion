import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LeadOutreachState } from '../../utils/assistantApi';
import { OutreachPauseControl } from './OutreachPauseControl';

const state = (over: Partial<LeadOutreachState> = {}): LeadOutreachState => ({
  paused: false,
  pausedAt: null,
  pausedBy: null,
  reason: null,
  canControl: true,
  ...over,
});

const render = (s: LeadOutreachState | null) => renderToString(<OutreachPauseControl leadId="lead-1" state={s} onChanged={() => undefined} />);

describe('OutreachPauseControl', () => {
  it('offers a pause while outreach runs, and a resume once paused', () => {
    expect(render(state())).toContain('Pause outreach');
    expect(render(state({ paused: true }))).toContain('Resume outreach');
  });

  it('shows nothing to a user who may not change the lead, or before the state has loaded', () => {
    expect(render(state({ canControl: false }))).toBe('');
    expect(render(null)).toBe('');
  });
});
