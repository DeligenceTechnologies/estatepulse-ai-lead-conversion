import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AssistantAction, BulkProgress } from '../../utils/assistantChatApi';
import { ApprovalCard } from './ApprovalCard';
import { BulkProgressView } from './BulkProgress';

const strip = (html: string) => html.replace(/<!-- -->/g, '');

const bulkCard = (total: number, over: Partial<AssistantAction> = {}): AssistantAction => ({
  id: 'act-1',
  messageId: 'msg-1',
  tool: 'leads_assign',
  status: 'proposed',
  title: `Assign ${total} leads to Priya Shah`,
  summary: 'Includes Maria Lopez and more.',
  changes: [{ field: 'Leads', from: null, to: String(total) }],
  error: null,
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  decidedAt: null,
  bulk: { total, status: null, sample: ['Maria Lopez'], skipped: {} },
  ...over,
});

const progress = (over: Partial<BulkProgress> = {}): BulkProgress => ({
  actionId: 'act-1',
  status: 'running',
  total: 40,
  done: 12,
  failed: 1,
  skipped: 2,
  notAttempted: 0,
  pending: 25,
  problems: [{ leadId: 'l1', name: 'Raj Mehta', status: 'skipped', reason: 'Priya Shah is at their lead limit' }],
  ...over,
});

describe('bulk cards', () => {
  it('above ten leads, asks for the count and keeps Approve off until it is typed', () => {
    const html = renderToString(<ApprovalCard action={bulkCard(40)} disabled={false} onDecide={() => undefined} />);
    expect(html).toContain('placeholder="Type 40"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Approve/s);
  });

  it('up to ten leads, approves like any card', () => {
    const html = renderToString(<ApprovalCard action={bulkCard(4)} disabled={false} onDecide={() => undefined} />);
    expect(html).not.toContain('placeholder="Type');
  });

  it('while the job runs, shows how far it got, Stop, and the leads left out with why', () => {
    const html = strip(renderToString(<BulkProgressView progress={progress()} status="running" total={40} onStop={() => undefined} />));
    expect(html).toContain('Working… 15 of 40');
    expect(html).toContain('Stop');
    expect(html).toContain('12 done · 2 skipped · 1 failed');
    expect(html).toContain('Raj Mehta');
    expect(html).toContain('Priya Shah is at their lead limit');
  });

  it('once ended, says how, without Stop', () => {
    const html = strip(renderToString(<BulkProgressView progress={progress({ status: 'cancelled', pending: 0, notAttempted: 25 })} status="cancelled" total={40} onStop={() => undefined} />));
    expect(html).toContain('Stopped by you');
    expect(html).toContain('25 not attempted');
    expect(html).not.toContain('>Stop<');
  });
});
