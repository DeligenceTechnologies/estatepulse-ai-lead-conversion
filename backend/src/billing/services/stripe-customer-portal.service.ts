import { Injectable } from '@nestjs/common';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { BillingConfig } from '../billing.config';
import { BILLING_ERRORS } from '../billing.constants';
import { BillingRepository } from '../billing.repository';
import { StripeService } from './stripe.service';

/**
 * Stripe's hosted Customer Portal: card changes, invoices, cancellation. The
 * portal is opened for the session's organization's own customer only; what it
 * changes reaches us through the same webhooks as everything else.
 */
@Injectable()
export class StripeCustomerPortalService {
  constructor(
    private readonly config: BillingConfig,
    private readonly stripe: StripeService,
    private readonly repo: BillingRepository,
    private readonly audit: AuditService,
  ) {}

  async createPortalSession(auth: AuthContext): Promise<{ url: string }> {
    const row = await this.repo.findByOrg(auth.organizationId);
    if (!row?.stripeCustomerId) {
      throw new AppError(BILLING_ERRORS.NO_BILLING_ACCOUNT, 'There is no billing account yet. Choose a plan first.', undefined, 409);
    }
    if (!this.config.portalReturnUrl) {
      throw new AppError(BILLING_ERRORS.NOT_CONFIGURED, 'The billing portal return URL is not configured.', undefined, 503);
    }
    const customer = row.stripeCustomerId;
    const session = await this.stripe.call('billingPortal.sessions.create', (s) =>
      s.billingPortal.sessions.create({
        customer,
        return_url: this.config.portalReturnUrl!,
        ...(this.config.portalConfigurationId ? { configuration: this.config.portalConfigurationId } : {}),
      }),
    );
    this.audit.quietly({
      orgId: auth.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'billing.portal_opened',
      entityType: 'subscription',
      entityId: row.id,
    });
    return { url: session.url };
  }
}
