import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AssistantSettingsView } from '../../utils/assistantSettingsApi';
import { AssistantLogTable, AssistantSpend } from './AssistantSettings';

const view = (over: Partial<AssistantSettingsView['usage']> = {}): AssistantSettingsView => ({
  settings: { enabled: true, monthlyLimitUsd: null, voiceEnabled: true },
  usage: { period: '2026-11', usedMicros: 2_500_000, budgetMicros: 20_000_000, planBudgetMicros: 20_000_000, officeLimitMicros: null, requests: 50, ...over },
  serverEnabled: true,
  canEdit: true,
});

describe('Settings > Ask EstatePulse', () => {
  it("shows this month's spend against the limit, and the average cost of a question", () => {
    const html = renderToString(<AssistantSpend view={view()} />).replace(/<!-- -->/g, '');
    expect(html).toContain('$2.50');
    expect(html).toContain('$20.00');
    expect(html).toContain('50 questions');
    expect(html).toContain('about $0.05 each');
    expect(html).toContain("Your plan&#x27;s allowance applies.");
  });

  it('says when the office limit is the one that applies', () => {
    expect(renderToString(<AssistantSpend view={view({ officeLimitMicros: 5_000_000, budgetMicros: 5_000_000 })} />)).toContain('Your office limit applies.');
  });

  it('logs who asked, what the assistant did, and how it ended', () => {
    const html = renderToString(
      <AssistantLogTable
        entries={[
          { id: 'a1', at: '2026-11-26T10:00:00Z', user: 'Sunny Patel', tool: 'text_send', what: 'Text Maria Lopez', tier: 'write', status: 'rejected', error: null },
          { id: 'a2', at: '2026-11-26T09:00:00Z', user: null, tool: 'lead_search', what: 'Searching leads', tier: 'read', status: 'executed', error: null },
        ]}
      />,
    );
    expect(html).toContain('Text Maria Lopez');
    expect(html).toContain('Declined');
    expect(html).toContain('Former member');
    expect(html).toContain('Searching leads');
  });
});
