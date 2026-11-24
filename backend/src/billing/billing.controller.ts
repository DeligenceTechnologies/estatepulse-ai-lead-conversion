import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { Public } from '@/auth/decorators/public.decorator';
import type { ListQuery } from '@/common/pagination/pagination.types';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { BillingService } from './billing.service';
import { CancelSubscriptionDto, CheckoutStatusParams, SelectPlanDto } from './dto/billing.dto';
import { StripeCheckoutService } from './services/stripe-checkout.service';
import { StripeCustomerPortalService } from './services/stripe-customer-portal.service';
import { SubscriptionService } from './services/subscription.service';

/** /api/billing — always scoped to the session's organization. */
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly checkout: StripeCheckoutService,
    private readonly portal: StripeCustomerPortalService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  @Public()
  @Get('plans')
  plans() {
    return this.billing.plans();
  }

  @Get('subscription')
  @RequirePermissions(PERMISSIONS.BILLING_READ)
  subscription(@CurrentAuth() auth: AuthContext) {
    return this.billing.subscription(auth.organizationId);
  }

  @Get('usage')
  @RequirePermissions(PERMISSIONS.BILLING_READ)
  usage(@CurrentAuth() auth: AuthContext) {
    return this.billing.usage(auth.organizationId);
  }

  @Get('invoices')
  @RequirePermissions(PERMISSIONS.BILLING_READ)
  invoices(@CurrentAuth() auth: AuthContext, @Query() query: ListQuery) {
    return this.billing.invoices(auth.organizationId, query);
  }

  @Post('checkout')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.BILLING_MANAGE)
  createCheckout(@CurrentAuth() auth: AuthContext, @Body() body: SelectPlanDto) {
    return this.checkout.createCheckout(auth, body.plan, body.interval);
  }

  @Get('checkout/:sessionId')
  @RequirePermissions(PERMISSIONS.BILLING_READ)
  checkoutStatus(@CurrentAuth() auth: AuthContext, @Param() params: CheckoutStatusParams) {
    return this.checkout.checkoutStatus(auth, params.sessionId);
  }

  @Post('portal')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.BILLING_MANAGE)
  createPortal(@CurrentAuth() auth: AuthContext) {
    return this.portal.createPortalSession(auth);
  }

  @Post('change-plan')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.BILLING_MANAGE)
  changePlan(@CurrentAuth() auth: AuthContext, @Body() body: SelectPlanDto) {
    return this.subscriptions.changePlan(auth, body.plan, body.interval);
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.BILLING_MANAGE)
  cancel(@CurrentAuth() auth: AuthContext, @Body() body: CancelSubscriptionDto) {
    return this.subscriptions.cancel(auth, body.immediately === true);
  }

  @Post('reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.BILLING_MANAGE)
  reactivate(@CurrentAuth() auth: AuthContext) {
    return this.subscriptions.reactivate(auth);
  }
}
