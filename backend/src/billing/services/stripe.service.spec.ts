import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { BillingConfig } from '../billing.config';
import { fakeStripe, makeConfig, signedDelivery, stripeServiceWith } from '../billing-fakes.test';
import { StripeService } from './stripe.service';

const statusOf = (error: unknown) => (error as { getStatus(): number }).getStatus();
const codeOf = (error: unknown) => ((error as { getResponse(): { error: { code: string } } }).getResponse()).error.code;

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('StripeService', () => {
  it('is not configured without a secret key, and says so instead of calling Stripe', () => {
    const service = new StripeService(new BillingConfig({}));
    expect(service.configured).toBe(false);
    let error: unknown;
    try {
      void service.client;
    } catch (e) {
      error = e;
    }
    expect(statusOf(error)).toBe(503);
    expect(codeOf(error)).toBe('BILLING_NOT_CONFIGURED');
  });

  it('turns a card decline into 402 with the cardholder message', async () => {
    const service = stripeServiceWith(fakeStripe());
    const error = await caught(
      service.call('x', async () => {
        throw new Stripe.errors.StripeCardError({ type: 'card_error', message: 'Your card was declined.', code: 'card_declined' });
      }),
    );
    expect(statusOf(error)).toBe(402);
    expect(codeOf(error)).toBe('PAYMENT_FAILED');
    expect((error as Error).message).toBe('Your card was declined.');
  });

  it('hides Stripe’s own wording for an invalid request, and a bad key becomes "not configured"', async () => {
    const service = stripeServiceWith(fakeStripe());
    const invalid = await caught(
      service.call('x', async () => {
        throw new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'No such price: price_secret_123' });
      }),
    );
    expect(statusOf(invalid)).toBe(502);
    expect((invalid as Error).message).not.toContain('price_secret_123');

    const auth = await caught(
      service.call('x', async () => {
        throw new Stripe.errors.StripeAuthenticationError({ type: 'authentication_error', message: 'Invalid API Key provided: sk_test_****' });
      }),
    );
    expect(codeOf(auth)).toBe('BILLING_NOT_CONFIGURED');
    expect((auth as Error).message).not.toContain('sk_test');
  });

  it('reports Stripe being down as a retryable upstream error', async () => {
    const service = stripeServiceWith(fakeStripe());
    const error = await caught(
      service.call('x', async () => {
        throw new Stripe.errors.StripeConnectionError({ type: 'api_connection_error' as never, message: 'socket hang up' });
      }),
    );
    expect(statusOf(error)).toBe(502);
    expect(codeOf(error)).toBe('UPSTREAM_ERROR');
  });

  describe('webhook signatures', () => {
    const event = { id: 'evt_1', type: 'invoice.paid', data: { object: { id: 'in_1', object: 'invoice' } } };

    it('accepts a delivery signed with the endpoint secret', () => {
      const stripe = fakeStripe();
      const { rawBody, signature } = signedDelivery(stripe, event);
      expect(stripeServiceWith(stripe).constructWebhookEvent(rawBody, signature).id).toBe('evt_1');
    });

    it('rejects a delivery signed with another secret, or altered after signing', () => {
      const stripe = fakeStripe();
      const service = stripeServiceWith(stripe, makeConfig());
      const forged = signedDelivery(stripe, event, 'whsec_attacker');
      expect(() => service.constructWebhookEvent(forged.rawBody, forged.signature)).toThrow(Stripe.errors.StripeSignatureVerificationError);

      const genuine = signedDelivery(stripe, event);
      const altered = Buffer.from(genuine.rawBody.toString().replace('in_1', 'in_2'));
      expect(() => service.constructWebhookEvent(altered, genuine.signature)).toThrow(Stripe.errors.StripeSignatureVerificationError);
    });
  });
});
