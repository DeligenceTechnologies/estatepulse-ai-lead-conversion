import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));

import { SOURCE_LABEL, analysisUnavailableOf, qualificationOf } from './leadScoringApi';

const q = { source: 'retell_analysis', score: 60, temperature: 'warm', reasons: [], override: null, thresholds: { hot: 75, warm: 45 }, scoredAt: 'now' };

describe('lead qualification labels', () => {
  it('names where a score came from: the provider’s structured analysis is never called transcript-scored', () => {
    expect(SOURCE_LABEL.telnyx_insights).toBe('scored when the call ended');
    expect(SOURCE_LABEL.retell_analysis).toBe('scored from Retell’s post-call analysis');
    expect(SOURCE_LABEL.transcript).toBe('scored from the transcript');
  });

  it('reads a scored call, and says why an unscored one could not be scored', () => {
    expect(qualificationOf({ qualification: q })).toEqual(q);
    expect(analysisUnavailableOf({ qualification: q, analysis: { status: 'unavailable', reason: 'late' } })).toBeNull();
    expect(analysisUnavailableOf({ analysis: { status: 'unavailable', reason: 'Retell sent no call analysis' } })).toBe('Retell sent no call analysis');
    expect(analysisUnavailableOf({ analysis: { status: 'unavailable' } })).toBe('The call analysis is unavailable');
    expect(analysisUnavailableOf({})).toBeNull();
    expect(analysisUnavailableOf(null)).toBeNull();
  });
});
