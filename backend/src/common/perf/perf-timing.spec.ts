import { describe, expect, it } from 'vitest';
import { resolvePerfEnabled } from './perf-timing';

describe('resolvePerfEnabled', () => {
  it('is off by default', () => {
    expect(resolvePerfEnabled({ NODE_ENV: 'development' })).toEqual({ enabled: false, refused: false });
  });

  it('turns on with PERF_TIMING=1 outside production', () => {
    expect(resolvePerfEnabled({ NODE_ENV: 'development', PERF_TIMING: '1' })).toEqual({ enabled: true, refused: false });
  });

  it('stays off in production even when PERF_TIMING=1, and reports the refusal', () => {
    expect(resolvePerfEnabled({ NODE_ENV: 'production', PERF_TIMING: '1' })).toEqual({ enabled: false, refused: true });
  });

  it('only the exact string "1" turns it on', () => {
    expect(resolvePerfEnabled({ PERF_TIMING: 'true' }).enabled).toBe(false);
  });
});
