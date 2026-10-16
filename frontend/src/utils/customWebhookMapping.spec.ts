import { describe, expect, it } from 'vitest';
import { curlExample, customStatus, draftFromFields, draftProblems, fieldsFromDraft } from './customWebhookMapping';

describe('custom webhook mapping draft', () => {
  it('round-trips fields through the one-choice-per-path draft, dropping "don’t import"', () => {
    const fields = [
      { path: 'name', target: 'full_name' as const },
      { path: 'contact.phone', target: 'phone' as const },
      { path: 'meta.source', target: '__custom__' as const, customName: 'Source' },
    ];
    const draft = draftFromFields(fields);
    expect(draft).toEqual({
      name: { target: 'full_name', customName: '' },
      'contact.phone': { target: 'phone', customName: '' },
      'meta.source': { target: '__custom__', customName: 'Source' },
    });
    expect(fieldsFromDraft({ ...draft, skipped: { target: '', customName: '' } })).toEqual(fields);
  });

  it('blocks saving without a contact, with a column filled twice, or an unnamed extra field', () => {
    expect(draftProblems([{ path: 'name', target: 'full_name' }])).toEqual(['Choose the path with the phone or the email.']);
    expect(draftProblems([{ path: 'a', target: 'phone' }, { path: 'b', target: 'first_name' }, { path: 'c', target: 'full_name' }])).toEqual([
      'First name is filled from more than one path.',
    ]);
    expect(draftProblems([{ path: 'a', target: 'email' }, { path: 'x', target: '__custom__', customName: ' ' }])).toEqual(['Name the extra field for x.']);
    expect(
      draftProblems([
        { path: 'a', target: 'email' },
        { path: 'x', target: '__custom__', customName: 'Tag' },
        { path: 'y', target: '__custom__', customName: 'tag' },
      ]),
    ).toEqual(['Two paths are both named "tag".']);
    expect(draftProblems([{ path: 'a', target: 'email' }, { path: 'b', target: 'budget_range' }])).toEqual([]);
  });

  it('writes a curl command for each auth mode', () => {
    const url = 'https://api.example.com/ingest/v1/custom/whk_live_X';
    expect(curlExample(url, { mode: 'none' }, null)).toContain(`curl -X POST '${url}'`);
    expect(curlExample(url, { mode: 'header_secret', headerName: 'x-webhook-secret' }, 'whsec_1')).toContain("-H 'x-webhook-secret: whsec_1'");
    expect(curlExample(url, { mode: 'basic', username: 'zapier' }, 'whsec_1')).toContain("-u 'zapier:whsec_1'");
    const hmac = curlExample(url, { mode: 'hmac', headerName: 'x-signature', algorithm: 'sha256', encoding: 'hex', prefix: 'sha256=' }, 'whsec_1');
    expect(hmac).toContain('openssl dgst -sha256 -hmac');
    expect(hmac).toContain("-H 'x-signature: sha256='\"$SIG\"");
  });

  it('names where a webhook stands from the summary fields', () => {
    expect(customStatus({ ingestStatus: 'AWAITING_FIRST_EVENT', mappingStatus: 'UNCONFIGURED', isActive: true }).label).toBe('waiting for payload');
    expect(customStatus({ ingestStatus: 'NEEDS_MAPPING', mappingStatus: 'UNCONFIGURED', isActive: true }).label).toBe('needs mapping');
    expect(customStatus({ ingestStatus: 'NEEDS_MAPPING', mappingStatus: 'CONFIGURED', isActive: true }).label).toBe('ready to switch on');
    expect(customStatus({ ingestStatus: 'ACTIVE', mappingStatus: 'CONFIGURED', isActive: true }).label).toBe('active');
    expect(customStatus({ ingestStatus: 'PAUSED', mappingStatus: 'CONFIGURED', isActive: false }).label).toBe('paused');
  });
});
