import { Injectable } from '@nestjs/common';
import {
  BillingEventStatus,
  Prisma,
  type BillingInterval,
  type Subscription,
  type SubscriptionPlan,
} from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { paginate } from '@/common/pagination/paginate';
import type { ListQuery } from '@/common/pagination/pagination.types';
import { MAX_EVENT_ATTEMPTS, STALE_PROCESSING_MS } from './billing.constants';

export type SubscriptionRow = Subscription;

const INVOICE_FIELDS = {
  id: true,
  stripeInvoiceId: true,
  number: true,
  amountDue: true,
  amountPaid: true,
  currency: true,
  status: true,
  invoiceUrl: true,
  invoicePdf: true,
  periodStart: true,
  periodEnd: true,
  dueDate: true,
  paidAt: true,
  issuedAt: true,
} satisfies Prisma.InvoiceSelect;

/**
 * Every billing read and write. Each method that touches an organization's
 * rows takes its id explicitly and puts it in the WHERE, so a caller cannot
 * reach another organization's subscription by passing a different row id.
 */
@Injectable()
export class BillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- Subscriptions -------------------------------------------------------

  findByOrg(orgId: string): Promise<SubscriptionRow | null> {
    return this.prisma.subscription.findUnique({ where: { orgId } });
  }

  /** The organization's row, created on the free plan if it has none. */
  ensure(orgId: string): Promise<SubscriptionRow> {
    return this.prisma.subscription.upsert({ where: { orgId }, create: { orgId }, update: {} });
  }

  findByCustomerId(stripeCustomerId: string): Promise<SubscriptionRow | null> {
    return this.prisma.subscription.findUnique({ where: { stripeCustomerId } });
  }

  /** First writer wins; returns the row as stored afterwards. */
  async setCustomerIfMissing(orgId: string, stripeCustomerId: string): Promise<SubscriptionRow> {
    await this.prisma.subscription.updateMany({ where: { orgId, stripeCustomerId: null }, data: { stripeCustomerId } });
    return this.prisma.subscription.findUniqueOrThrow({ where: { orgId } });
  }

  update(orgId: string, data: Prisma.SubscriptionUpdateInput, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    return db.subscription.update({ where: { orgId }, data });
  }

  setCheckout(orgId: string, checkout: { sessionId: string; plan: SubscriptionPlan; interval: BillingInterval; expiresAt: Date }) {
    return this.prisma.subscription.update({
      where: { orgId },
      data: {
        checkoutSessionId: checkout.sessionId,
        checkoutPlan: checkout.plan,
        checkoutInterval: checkout.interval,
        checkoutExpiresAt: checkout.expiresAt,
      },
    });
  }

  /** Clears the remembered Checkout Session, only if it is still the given one. */
  clearCheckout(orgId: string, sessionId: string) {
    return this.prisma.subscription.updateMany({
      where: { orgId, checkoutSessionId: sessionId },
      data: { checkoutSessionId: null, checkoutPlan: null, checkoutInterval: null, checkoutExpiresAt: null },
    });
  }

  /** Paid subscriptions not copied from Stripe since `before`, for the reconciler. */
  staleSubscriptions(before: Date, take: number) {
    return this.prisma.subscription.findMany({
      where: {
        stripeSubscriptionId: { not: null },
        status: { notIn: ['canceled', 'incomplete_expired'] },
        OR: [{ syncedAt: null }, { syncedAt: { lt: before } }],
      },
      select: { orgId: true, stripeSubscriptionId: true },
      orderBy: { syncedAt: { sort: 'asc', nulls: 'first' } },
      take,
    });
  }

  // --- Organization facts billing needs ------------------------------------

  organization(orgId: string) {
    return this.prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true } });
  }

  userEmail(orgId: string, userId: string) {
    return this.prisma.user
      .findFirst({ where: { id: userId, orgId }, select: { email: true } })
      .then((u) => u?.email ?? null);
  }

  countActiveMembers(orgId: string, db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<number> {
    return db.user.count({ where: { orgId, status: 'active' } });
  }

  hasBillingHistory(orgId: string): Promise<boolean> {
    return this.prisma.invoice.count({ where: { orgId } }).then((n) => n > 0);
  }

  // --- Invoices and payments -----------------------------------------------

  upsertInvoice(stripeInvoiceId: string, data: Omit<Prisma.InvoiceUncheckedCreateInput, 'stripeInvoiceId'>) {
    const { orgId: _org, ...update } = data;
    return this.prisma.invoice.upsert({
      where: { stripeInvoiceId },
      create: { ...data, stripeInvoiceId },
      // The organization of an invoice never changes.
      update,
    });
  }

  findPayment(stripeInvoiceId: string) {
    return this.prisma.payment.findUnique({ where: { stripeInvoiceId } });
  }

  upsertPayment(stripeInvoiceId: string, data: Omit<Prisma.PaymentUncheckedCreateInput, 'stripeInvoiceId'>) {
    const { orgId: _org, ...update } = data;
    return this.prisma.payment.upsert({
      where: { stripeInvoiceId },
      create: { ...data, stripeInvoiceId },
      update,
    });
  }

  listInvoices(orgId: string, query: ListQuery) {
    return paginate(query, {
      where: { orgId } as Prisma.InvoiceWhereInput,
      filters: { status: { type: 'enum', values: ['draft', 'open', 'paid', 'uncollectible', 'void'] } },
      sortableFields: ['issuedAt', 'amountDue'] as const,
      defaultSort: [{ issuedAt: 'desc' }],
      findMany: (args) => this.prisma.invoice.findMany({ ...args, select: INVOICE_FIELDS }),
      count: (args) => this.prisma.invoice.count(args),
    });
  }

  // --- Webhook events ------------------------------------------------------

  /** Stores the event once; a redelivery returns the row already there. */
  async recordEvent(event: {
    stripeEventId: string;
    eventType: string;
    livemode: boolean;
    metadata: Prisma.InputJsonValue;
    stripeCreatedAt: Date;
  }) {
    try {
      return { created: true, row: await this.prisma.billingEvent.create({ data: event }) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const row = await this.prisma.billingEvent.findUniqueOrThrow({ where: { stripeEventId: event.stripeEventId } });
        return { created: false, row };
      }
      throw error;
    }
  }

  /**
   * Takes the event for processing. Only one worker gets it: the update is
   * conditional on it being pending, failed, or stuck in processing (a crashed
   * worker). Returns false when someone else holds it or it is already done.
   */
  async claimEvent(id: string, now = new Date()): Promise<boolean> {
    const { count } = await this.prisma.billingEvent.updateMany({
      where: {
        id,
        OR: [
          { processingStatus: { in: [BillingEventStatus.pending, BillingEventStatus.failed] } },
          { processingStatus: BillingEventStatus.processing, updatedAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } },
        ],
      },
      data: { processingStatus: BillingEventStatus.processing, attempts: { increment: 1 } },
    });
    return count === 1;
  }

  finishEvent(id: string, result: { status: 'processed' | 'ignored' | 'failed'; orgId?: string | null; error?: string }) {
    return this.prisma.billingEvent.update({
      where: { id },
      data: {
        processingStatus: result.status,
        ...(result.orgId !== undefined ? { orgId: result.orgId } : {}),
        errorMessage: result.error ? result.error.slice(0, 1000) : null,
        processedAt: result.status === 'failed' ? null : new Date(),
      },
    });
  }

  /** Events to run again: failed, or stored but never finished. */
  retryableEvents(olderThan: Date, take: number) {
    return this.prisma.billingEvent.findMany({
      where: {
        attempts: { lt: MAX_EVENT_ATTEMPTS },
        updatedAt: { lt: olderThan },
        processingStatus: { in: [BillingEventStatus.failed, BillingEventStatus.pending, BillingEventStatus.processing] },
      },
      select: { id: true, stripeEventId: true },
      orderBy: { createdAt: 'asc' },
      take,
    });
  }
}
