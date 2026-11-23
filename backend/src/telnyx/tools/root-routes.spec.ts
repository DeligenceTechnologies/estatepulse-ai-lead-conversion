import { describe, expect, it } from 'vitest';
import { ROOT_ROUTES } from '@/root-routes';
import { callToolDefinitions } from './call-tools';

const API = 'https://api.example.com';

describe('assistant tool URLs', () => {
  it('every tool the assistant is given is served at the root, outside the /api prefix', () => {
    const urls = callToolDefinitions(API, 'secret', true, true).map((t) => (t as { webhook: { url: string } }).webhook.url);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith(`${API}/`)).toBe(true);
      expect(ROOT_ROUTES).toContain(url.slice(API.length + 1));
    }
    // The booking tools' URLs are built in InCallBookingSettingsService.
    expect(ROOT_ROUTES).toEqual(expect.arrayContaining(['tools/telnyx/booking/availability', 'tools/telnyx/booking/book']));
  });
});
