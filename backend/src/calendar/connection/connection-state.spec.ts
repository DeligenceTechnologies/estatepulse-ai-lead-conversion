import { describe, expect, it } from 'vitest';
import { connectionHealth, inUse } from './connection-state';

describe('connection state', () => {
  it('treats active and error as in use, never inactive', () => {
    expect(inUse('org-1')).toEqual({ orgId: 'org-1', status: { in: ['active', 'error'] } });
  });

  it('reports health whether or not the connection is in use', () => {
    expect(connectionHealth({ status: 'active', lastError: null })).toBe('active');
    expect(connectionHealth({ status: 'error', lastError: 'Reconnect' })).toBe('error');
    expect(connectionHealth({ status: 'inactive', lastError: null })).toBe('active');
    expect(connectionHealth({ status: 'inactive', lastError: 'Reconnect' })).toBe('error');
  });
});
