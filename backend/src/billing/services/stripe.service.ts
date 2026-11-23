import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import Stripe from 'stripe';
import { AppError } from '@/common/errors/app-error';
import { BillingConfig } from '../billing.config';
import { BILLING_ERRORS } from '../billing.constants';

/** Lets tests hand in a mocked Stripe client. */
export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

/**
 * The only class that talks to the Stripe SDK. Everything else asks it for the
 * client and runs calls through `call()`, which turns Stripe's errors into the
 * app's `{ error: { code, message } }` responses without leaking Stripe's
 * request details, the key, or customer data into the response or the logs.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger('Stripe');
  private readonly stripe: Stripe | null;

  constructor(
    readonly config: BillingConfig,
    @Optional() @Inject(STRIPE_CLIENT) injected?: Stripe,
  ) {
    const key = config.stripeSecretKey();
    this.stripe =
      injected ??
      (key
        ? new Stripe(key, {
            maxNetworkRetries: 2,
            timeout: 20_000,
            appInfo: { name: 'EstatePulse' },
          })
        : null);
    if (!this.stripe) {
      this.logger.log('Stripe is not configured (no STRIPE_SECRET_KEY); every organization is on the free plan.');
    }
  }

  get configured(): boolean {
    return this.stripe !== null;
  }

  /** The SDK client; throws BILLING_NOT_CONFIGURED when there is no key. */
  get client(): Stripe {
    if (!this.stripe) {
      throw new AppError(BILLING_ERRORS.NOT_CONFIGURED, 'Billing is not configured on this server.', undefined, 503);
    }
    return this.stripe;
  }

  /**
   * Verifies a webhook against the exact bytes received. Throws
   * Stripe's signature error for a forged, altered or stale delivery.
   */
  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const secret = this.config.stripeWebhookSecret();
    if (!secret) {
      throw new AppError(BILLING_ERRORS.NOT_CONFIGURED, 'Stripe webhooks are not configured.', undefined, 503);
    }
    return this.client.webhooks.constructEvent(rawBody, signature, secret);
  }

  /** Runs one Stripe call; `op` names it in the logs. */
  async call<T>(op: string, fn: (stripe: Stripe) => Promise<T>): Promise<T> {
    const stripe = this.client;
    try {
      return await fn(stripe);
    } catch (error) {
      throw this.translate(op, error);
    }
  }

  private translate(op: string, error: unknown): Error {
    if (error instanceof AppError) return error;
    if (!(error instanceof Stripe.errors.StripeError)) {
      this.logger.error(`${op} failed: ${(error as Error)?.message ?? String(error)}`);
      return new AppError('INTERNAL', 'Billing request failed.', undefined, 500);
    }
    // Type, code and request id are what Stripe support needs; none is sensitive.
    const where = `${op}: ${error.type}${error.code ? `/${error.code}` : ''} (status ${error.statusCode ?? '-'}, request ${error.requestId ?? '-'})`;

    if (error instanceof Stripe.errors.StripeCardError) {
      this.logger.warn(where);
      // Card messages ("Your card was declined.") are written for the cardholder.
      return new AppError(BILLING_ERRORS.PAYMENT_FAILED, error.message, undefined, 402);
    }
    if (error instanceof Stripe.errors.StripeAuthenticationError || error instanceof Stripe.errors.StripePermissionError) {
      this.logger.error(`${where} — check STRIPE_SECRET_KEY`);
      return new AppError(BILLING_ERRORS.NOT_CONFIGURED, 'Billing is not configured correctly on this server.', undefined, 503);
    }
    if (
      error instanceof Stripe.errors.StripeConnectionError ||
      error instanceof Stripe.errors.StripeAPIError ||
      error instanceof Stripe.errors.StripeRateLimitError
    ) {
      this.logger.warn(where);
      return new AppError('UPSTREAM_ERROR', 'The payment provider is temporarily unavailable. Please try again.', undefined, 502);
    }
    if (error instanceof Stripe.errors.StripeIdempotencyError) {
      this.logger.warn(where);
      return new AppError('CONFLICT', 'A billing request like this one is already in progress. Please try again in a moment.');
    }
    this.logger.error(`${where}: ${error.message}`);
    return new AppError(BILLING_ERRORS.PROVIDER_ERROR, 'The payment provider rejected the request.', undefined, 502);
  }
}

/** Stripe ids come either as a string or as the expanded object. */
export function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

export const fromUnix = (seconds: number | null | undefined): Date | null =>
  seconds === null || seconds === undefined ? null : new Date(seconds * 1000);
