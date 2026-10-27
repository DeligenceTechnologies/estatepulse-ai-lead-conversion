// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StrategyEditorPayload, StrategyStep } from '../../utils/strategiesApi';

/** The strategy screen: two fixed cards and "Swap order" with conditional outreach on; the older free-form list without it. */

const api = vi.hoisted(() => ({ getStrategyEditor: vi.fn(), saveStrategySteps: vi.fn(), saveStrategy: vi.fn() }));
vi.mock('../../utils/strategiesApi', async (original) => ({ ...(await original<typeof import('../../utils/strategiesApi')>()), ...api }));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { StrategyEditor } from './StrategyEditor';

const call: StrategyStep = { id: 'call', after: { value: 0, unit: 'minutes' }, channel: 'voice', action: 'ai_call' };
const sms: StrategyStep = { id: 'sms', after: { value: 5, unit: 'minutes' }, channel: 'sms', action: 'send_sms', message: 'Missed you', onlyIf: { match: 'all', rules: [] } };
const rules = [{ id: 'meeting_booked', label: 'A meeting is booked', kind: 'never_sends' as const, appliesTo: ['strategy' as const] }];

const payload = (over: Partial<StrategyEditorPayload> = {}): StrategyEditorPayload => ({
  strategy: { name: 'S', steps: [call, sms], timing: 'after_previous' },
  editor: { steps: [call, sms], converted: false },
  safetyRules: rules,
  ...over,
});

describe('StrategyEditor', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('shows the call first and the SMS after it, each with its plain-English line and the built-in rules', async () => {
    api.getStrategyEditor.mockResolvedValue(payload());
    render(<StrategyEditor />);
    expect(await screen.findByText('This call goes as soon as the lead comes in, within contact hours.')).toBeTruthy();
    expect(screen.getByText('This SMS goes 5 min after the call ends.')).toBeTruthy();
    expect(screen.getAllByText(/A meeting is booked/)).toHaveLength(2);
    expect(screen.queryByText('Add SMS')).toBeNull();
  });

  it('"Swap order" sends the SMS first, with the call waiting after it, and saves the steps as shown', async () => {
    api.getStrategyEditor.mockResolvedValue(payload());
    api.saveStrategySteps.mockResolvedValue(payload({ editor: { steps: [sms, call], converted: false } }));
    render(<StrategyEditor />);
    await screen.findByText('Swap order');
    fireEvent.click(screen.getByText('Swap order'));
    expect(screen.getByText('This SMS goes as soon as the lead comes in, within contact hours.')).toBeTruthy();
    expect(screen.getByText('This call goes 5 min after the SMS is sent.')).toBeTruthy();
    fireEvent.click(screen.getByText('Save Strategy'));
    await waitFor(() => expect(api.saveStrategySteps).toHaveBeenCalledOnce());
    const [saved] = api.saveStrategySteps.mock.calls[0];
    expect(saved.map((s: StrategyStep) => [s.channel, s.after.value])).toEqual([
      ['sms', 0],
      ['voice', 5],
    ]);
  });

  it('a mistake is caught before Save: nothing is sent', async () => {
    api.getStrategyEditor.mockResolvedValue(payload({ editor: { steps: [call, { ...sms, message: '' }], converted: false } }));
    render(<StrategyEditor />);
    await screen.findByText('Save Strategy');
    fireEvent.click(screen.getByText('Save Strategy'));
    expect(await screen.findByText('The SMS step needs a message.')).toBeTruthy();
    expect(api.saveStrategySteps).not.toHaveBeenCalled();
  });

  it('an older saved strategy shows the note with its step count, until it is saved in the new form', async () => {
    const older: StrategyStep[] = [{ ...sms, id: 'a', after: { value: 0, unit: 'minutes' } }, { ...call, id: 'b', after: { value: 1, unit: 'minutes' } }, { ...sms, id: 'c' }];
    api.getStrategyEditor.mockResolvedValue(payload({ strategy: { name: 'Old', steps: older }, editor: { steps: [older[0], { ...call, after: { value: 1, unit: 'minutes' } }], converted: true } }));
    api.saveStrategySteps.mockResolvedValue(payload());
    render(<StrategyEditor />);
    expect(await screen.findByText(/Your saved strategy has 3 steps and keeps running as it is until you save/)).toBeTruthy();
    fireEvent.click(screen.getByText('Save Strategy'));
    await waitFor(() => expect(screen.queryByText(/Your saved strategy has 3 steps/)).toBeNull());
  });

  it('without conditional outreach on the server (no editor in the payload) the older free-form editor is shown', async () => {
    api.getStrategyEditor.mockResolvedValue({ strategy: { name: 'Old', steps: [{ ...sms, id: 'a', after: { value: 0, unit: 'minutes' } }, call] } });
    api.saveStrategy.mockResolvedValue({ name: 'Old', steps: [call] });
    render(<StrategyEditor />);
    expect(await screen.findByText('Add SMS')).toBeTruthy();
    expect(screen.getByText('Add Call')).toBeTruthy();
    expect(screen.queryByText('Swap order')).toBeNull();
    expect(screen.queryByText(/within contact hours/)).toBeNull();
    fireEvent.click(screen.getByText('Save Strategy'));
    await waitFor(() => expect(api.saveStrategy).toHaveBeenCalledWith({ steps: expect.arrayContaining([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'call' })]) }));
    expect(api.saveStrategySteps).not.toHaveBeenCalled();
  });
});
