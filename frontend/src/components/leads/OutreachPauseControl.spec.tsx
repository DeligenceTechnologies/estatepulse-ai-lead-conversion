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

  it('offers no pause when nothing would hold, and says why instead', () => {
    const html = render(state({ canPause: false, note: 'No outreach is running to pause: the lead is appointment booked.' }));
    expect(html).not.toContain('Pause outreach');
    expect(html).toContain('the lead is appointment booked');
  });

  it('offers no resume when nothing would restart, and says why', () => {
    const html = render(state({ paused: true, canResume: false, note: 'Nothing restarts by itself: the lead is appointment booked.' }));
    expect(html).not.toContain('Resume outreach');
    expect(html).toContain('Nothing restarts by itself');
    // A paused lead waiting for consent can still be resumed: outreach then starts once consent is recorded.
    expect(render(state({ paused: true, canResume: true }))).toContain('Resume outreach');
  });

  it('shows nothing to a user who may not change the lead, or before the state has loaded', () => {
    expect(render(state({ canControl: false }))).toBe('');
    expect(render(null)).toBe('');
  });
});
