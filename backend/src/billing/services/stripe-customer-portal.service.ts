import { HttpStatus, Injectable } from '@nestjs/common';
import { ActorType } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { BillingConfig } from '../billing.config';
import { BILLING_AUDIT_ENTITY, BillingAuditAction, BillingErrorCode } from '../billing.constants';
import { BillingRepository } from '../billing.repository';
import { StripeService } from './stripe.service';

/** Stripe-hosted Customer Portal; changes made there arrive via webhooks. */
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
      throw new AppError(BillingErrorCode.NO_BILLING_ACCOUNT, 'There is no billing account yet. Choose a plan first.', undefined, HttpStatus.CONFLICT);
    }
    const { portalReturnUrl, portalConfigurationId } = this.config;
    if (!portalReturnUrl) {
      throw new AppError(BillingErrorCode.NOT_CONFIGURED, 'The billing portal return URL is not configured.', undefined, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const customer = row.stripeCustomerId;
    const session = await this.stripe.call('billingPortal.sessions.create', (s) =>
      s.billingPortal.sessions.create({
        customer,
        return_url: portalReturnUrl,
        ...(portalConfigurationId && { configuration: portalConfigurationId }),
      }),
    );
    this.audit.quietly({
      orgId: auth.organizationId,
      actorType: ActorType.user,
      actorId: auth.userId,
      action: BillingAuditAction.PORTAL_OPENED,
      entityType: BILLING_AUDIT_ENTITY,
      entityId: row.id,
    });
    return { url: session.url };
  }
}
