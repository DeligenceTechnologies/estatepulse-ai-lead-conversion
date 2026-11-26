import { describe, expect, it } from 'vitest';
import { pathForView, viewForPath } from './AppContext';

describe('view <-> path', () => {
  it('round-trips every view, underscores as hyphens', () => {
    expect(pathForView('team_availability')).toBe('/team-availability');
    expect(viewForPath('/team-availability')).toBe('team_availability');
    expect(viewForPath('/leads/')).toBe('leads');
  });

  it('rejects paths that are not a view', () => {
    for (const p of ['/', '/xyz', '/availability', '/team_availability/extra']) {
      expect(viewForPath(p)).toBeNull();
    }
  });
});
