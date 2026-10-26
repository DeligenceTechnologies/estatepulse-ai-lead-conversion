import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RetellEnabledGuard } from './retell-enabled.guard';

const guard = (value: unknown) => new RetellEnabledGuard({ get: () => value } as any);

describe('RetellEnabledGuard', () => {
  it('answers 404 unless RETELL_ENABLED is on', () => {
    for (const off of [false, undefined]) {
      try {
        guard(off).canActivate();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(404);
        expect((error as HttpException).getResponse()).toEqual({ error: { code: 'RETELL_DISABLED', message: 'Retell is not enabled on this server.' } });
      }
    }
    expect(guard(true).canActivate()).toBe(true);
  });
});
