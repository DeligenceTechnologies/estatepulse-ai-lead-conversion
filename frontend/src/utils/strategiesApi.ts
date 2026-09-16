import { apiFetch } from '../lib/api';

export interface StrategyStep {
  id: string;
  after: { value: number; unit: 'seconds' | 'minutes' | 'hours' | 'days' };
  channel: 'sms' | 'voice';
  action?: string;
  template?: string;
  message?: string;
}
export interface Strategy {
  name: string;
  guardrails?: Record<string, unknown>;
  steps: StrategyStep[];
}

export const getStrategy = () =>
  apiFetch<{ strategy: Strategy }>('/strategy', { auth: true }).then((d) => d.strategy);

export const saveStrategy = (strategy: Partial<Strategy>) =>
  apiFetch<{ strategy: Strategy }>('/strategy', { method: 'PUT', body: strategy, auth: true }).then((d) => d.strategy);

export function emptyStep(): StrategyStep {
  return { id: `s${Math.random().toString(36).slice(2, 7)}`, after: { value: 5, unit: 'minutes' }, channel: 'sms', action: 'send_sms', message: '' };
}
