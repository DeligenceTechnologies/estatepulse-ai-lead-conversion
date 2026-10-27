// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The contact window writes the guardrails and nothing else: the steps the server showed are never written back by this card. */

const api = vi.hoisted(() => ({ getStrategy: vi.fn(), saveStrategy: vi.fn() }));
vi.mock('../../utils/strategiesApi', async (original) => ({ ...(await original<typeof import('../../utils/strategiesApi')>()), ...api }));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ContactWindowCard } from './ContactWindowCard';

describe('ContactWindowCard', () => {
  afterEach(cleanup);

  it('saves only the guardrails, keeping the keys it does not show; the steps (a default, perhaps) are not written back', async () => {
    const strategy = {
      name: 'S',
      guardrails: { stopOn: ['dnc'], quietHours: { start: '21:00', end: '08:00' } },
      steps: [{ id: 'a', after: { value: 0, unit: 'minutes' }, channel: 'voice', action: 'ai_call' }],
    };
    api.getStrategy.mockResolvedValue(strategy);
    api.saveStrategy.mockResolvedValue(strategy);
    render(<ContactWindowCard blurb="x" />);
    fireEvent.click(await screen.findByText('Save window'));
    await waitFor(() => expect(api.saveStrategy).toHaveBeenCalledOnce());
    expect(api.saveStrategy.mock.calls[0][0]).toEqual({
      guardrails: { stopOn: ['dnc'], respectQuietHours: true, quietHours: { start: '21:00', end: '08:00' }, maxVoiceAttempts: 3 },
    });
  });
});
