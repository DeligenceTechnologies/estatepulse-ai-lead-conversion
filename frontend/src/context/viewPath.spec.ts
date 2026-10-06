import { describe, expect, it } from 'vitest';
import { pathForView, viewForPath } from './AppContext';

describe('view <-> path', () => {
  it('round-trips every view, underscores as hyphens', () => {
    expect(pathForView('lead_sources')).toBe('/lead-sources');
    expect(viewForPath('/lead-sources')).toBe('lead_sources');
    expect(viewForPath('/leads/')).toBe('leads');
  });

  it('rejects paths that are not a view', () => {
    for (const p of ['/', '/xyz', '/availability', '/lead_sources/extra']) {
      expect(viewForPath(p)).toBeNull();
    }
  });
});
