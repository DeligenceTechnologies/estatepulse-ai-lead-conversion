import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { AppError } from '@/common/errors/app-error';
import { BillingConfig } from '../billing.config';
import { BillingErrorCode } from '../billing.constants';

/** The only Stripe SDK wrapper. `call()` maps Stripe errors to safe app errors. */
@Injectable()
export class StripeService {
  private readonly logger = new Logger('Stripe');
  private readonly stripe: Stripe | null;

  constructor(readonly config: BillingConfig) {
    const key = config.stripeSecretKey();
    this.stripe = key ? new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: 'EstatePulse' } }) : null;
    if (!this.stripe) this.logger.log('Stripe is not configured; every organization is on the free plan.');
  }

  get configured(): boolean {
    return this.stripe !== null;
  }

  get client(): Stripe {
    if (!this.stripe) {
      throw new AppError(BillingErrorCode.NOT_CONFIGURED, 'Billing is not configured on this server.', undefined, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return this.stripe;
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const secret = this.config.stripeWebhookSecret();
    if (!secret) throw new AppError(BillingErrorCode.NOT_CONFIGURED, 'Stripe webhooks are not configured.', undefined, HttpStatus.SERVICE_UNAVAILABLE);
    return this.client.webhooks.constructEvent(rawBody, signature, secret);
  }

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
      return new AppError('INTERNAL', 'Billing request failed.', undefined, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const where = `${op}: ${error.type}${error.code ? `/${error.code}` : ''} (status ${error.statusCode ?? '-'}, request ${error.requestId ?? '-'})`;

    if (error instanceof Stripe.errors.StripeCardError) {
      this.logger.warn(where);
      return new AppError(BillingErrorCode.PAYMENT_FAILED, error.message, undefined, HttpStatus.PAYMENT_REQUIRED);
    }
    if (error instanceof Stripe.errors.StripeAuthenticationError || error instanceof Stripe.errors.StripePermissionError) {
      this.logger.error(`${where} — check STRIPE_SECRET_KEY`);
      return new AppError(BillingErrorCode.NOT_CONFIGURED, 'Billing is not configured correctly on this server.', undefined, HttpStatus.SERVICE_UNAVAILABLE);
    }
    if (
      error instanceof Stripe.errors.StripeConnectionError ||
      error instanceof Stripe.errors.StripeAPIError ||
      error instanceof Stripe.errors.StripeRateLimitError
    ) {
      this.logger.warn(where);
      return new AppError('UPSTREAM_ERROR', 'The payment provider is temporarily unavailable. Please try again.', undefined, HttpStatus.BAD_GATEWAY);
    }
    if (error instanceof Stripe.errors.StripeIdempotencyError) {
      this.logger.warn(where);
      return new AppError('CONFLICT', 'A billing request like this one is already in progress. Please try again in a moment.');
    }
    this.logger.error(`${where}: ${error.message}`);
    return new AppError(BillingErrorCode.PROVIDER_ERROR, 'The payment provider rejected the request.', undefined, HttpStatus.BAD_GATEWAY);
  }
}

/** Stripe ids arrive as a string or an expanded object. */
export const stripeId = (value: string | { id: string } | null | undefined): string | null =>
  !value ? null : typeof value === 'string' ? value : value.id;

export const fromUnix = (seconds: number | null | undefined): Date | null =>
  seconds === null || seconds === undefined ? null : new Date(seconds * 1000);

/** Short stable hash for Stripe idempotency keys. */
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 40);
