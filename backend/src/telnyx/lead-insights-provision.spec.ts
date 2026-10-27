import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LeadInsightsService } from './lead-insights.service';
import { telnyx } from './telnyx-api';

/** The qualification Insight is re-sent, current schema and all, the first time each process needs it for an organization. */

vi.mock('./telnyx-api', () => ({ telnyx: vi.fn() }));

const creds = { getCreds: vi.fn().mockResolvedValue({ apiKey: 'KEY', assistantId: 'asst-1' }) };

describe('LeadInsightsService.ensureProvisioned', () => {
  beforeEach(() => {
    vi.mocked(telnyx).mockReset();
    vi.mocked(telnyx).mockImplementation(async (_key: string, path: string) => {
      if (path.startsWith('/ai/conversations/insights?')) return { data: [{ id: 'ins-1', name: 'EstatePulse lead qualification' }] };
      if (path === '/ai/conversations/insights/ins-1') return { data: { id: 'ins-1' } };
      if (path === '/ai/assistants/asst-1') return { data: { insight_settings: { insight_group_id: 'grp-1' } } };
      if (path === '/ai/conversations/insight-groups/grp-1') return { data: { insights: [{ id: 'ins-1' }] } };
      return {};
    });
  });

  it('updates an existing Insight with the current schema, reached_person included, once per process', async () => {
    const insights = new LeadInsightsService(creds as any);
    await insights.ensureProvisioned('org-1');
    await insights.ensureProvisioned('org-1');
    const puts = vi.mocked(telnyx).mock.calls.filter(([, path, init]) => path === '/ai/conversations/insights/ins-1' && init?.method === 'PUT');
    expect(puts).toHaveLength(1);
    const body = JSON.parse(String(puts[0][2]!.body));
    expect(body.json_schema.required).toContain('reached_person');
    expect(body.json_schema.properties.reached_person.type).toBe('boolean');
  });

  it('a new process (a deploy, a restart) sends it again', async () => {
    await new LeadInsightsService(creds as any).ensureProvisioned('org-1');
    await new LeadInsightsService(creds as any).ensureProvisioned('org-1');
    expect(vi.mocked(telnyx).mock.calls.filter(([, , init]) => init?.method === 'PUT')).toHaveLength(2);
  });
});
