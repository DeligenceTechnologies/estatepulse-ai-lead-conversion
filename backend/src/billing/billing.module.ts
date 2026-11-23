import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingConfig } from './billing.config';
import { BillingController } from './billing.controller';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { BillingWebhookController } from './billing-webhook.controller';
import { EntitlementService } from './entitlements/entitlement.service';
import { EntitlementGuard } from './entitlements/require-feature.decorator';
import { BillingReconcileService } from './services/billing-reconcile.service';
import { StripeCheckoutService } from './services/stripe-checkout.service';
import { StripeCustomerPortalService } from './services/stripe-customer-portal.service';
import { StripePriceService } from './services/stripe-price.service';
import { StripeWebhookService } from './services/stripe-webhook.service';
import { StripeService } from './services/stripe.service';
import { SubscriptionService } from './services/subscription.service';
import { SubscriptionSyncService } from './services/subscription-sync.service';

/**
 * Subscriptions and plan entitlements. Global so any module can put
 * @RequireFeature() on a route or call EntitlementService (UserService does,
 * for the member limit) without importing billing.
 */
@Global()
@Module({
  controllers: [BillingController, BillingWebhookController],
  providers: [
    { provide: BillingConfig, inject: [ConfigService], useFactory: (config: ConfigService) => BillingConfig.fromConfigService(config) },
    StripeService,
    StripePriceService,
    BillingRepository,
    SubscriptionSyncService,
    StripeCheckoutService,
    StripeCustomerPortalService,
    SubscriptionService,
    StripeWebhookService,
    BillingReconcileService,
    BillingService,
    EntitlementService,
    EntitlementGuard,
  ],
  exports: [BillingConfig, EntitlementService, EntitlementGuard],
})
export class BillingModule {}
