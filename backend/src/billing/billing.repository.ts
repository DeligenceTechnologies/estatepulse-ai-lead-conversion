import { Injectable } from '@nestjs/common';
import {
  BaseStatus,
  BillingEventStatus,
  Prisma,
  type BillingInterval,
  type Subscription,
  type SubscriptionPlan,
} from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { paginate } from '@/common/pagination/paginate';
import type { ListQuery } from '@/common/pagination/pagination.types';
import { InvoiceStatus, MAX_EVENT_ATTEMPTS, STALE_PROCESSING_MS, TERMINAL_STATUSES } from './billing.constants';

export type SubscriptionRow = Subscription;
type Db = Prisma.TransactionClient | PrismaService;

/** Final states a handled webhook event can be marked with. */
export type FinishedEventStatus = typeof BillingEventStatus.processed | typeof BillingEventStatus.ignored | typeof BillingEventStatus.failed;

export const CLEARED_CHECKOUT = {
  checkoutSessionId: null,
  checkoutPlan: null,
  checkoutInterval: null,
  checkoutExpiresAt: null,
} as const;

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

/** All billing DB access. Every org-scoped query filters by orgId. */
@Injectable()
export class BillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByOrg(orgId: string): Promise<SubscriptionRow | null> {
    return this.prisma.subscription.findUnique({ where: { orgId } });
  }

  ensure(orgId: string): Promise<SubscriptionRow> {
    return this.prisma.subscription.upsert({ where: { orgId }, create: { orgId }, update: {} });
  }

  findByCustomerId(stripeCustomerId: string): Promise<SubscriptionRow | null> {
    return this.prisma.subscription.findUnique({ where: { stripeCustomerId } });
  }

  /** First writer wins; returns the stored row. */
  async setCustomerIfMissing(orgId: string, stripeCustomerId: string): Promise<SubscriptionRow> {
    await this.prisma.subscription.updateMany({ where: { orgId, stripeCustomerId: null }, data: { stripeCustomerId } });
    return this.prisma.subscription.findUniqueOrThrow({ where: { orgId } });
  }

  update(orgId: string, data: Prisma.SubscriptionUpdateInput, db: Db = this.prisma) {
    return db.subscription.update({ where: { orgId }, data });
  }

  setCheckout(orgId: string, c: { sessionId: string; plan: SubscriptionPlan; interval: BillingInterval; expiresAt: Date }) {
    return this.prisma.subscription.update({
      where: { orgId },
      data: { checkoutSessionId: c.sessionId, checkoutPlan: c.plan, checkoutInterval: c.interval, checkoutExpiresAt: c.expiresAt },
    });
  }

  /** Clears the stored checkout only if it is still `sessionId`. */
  clearCheckout(orgId: string, sessionId: string) {
    return this.prisma.subscription.updateMany({ where: { orgId, checkoutSessionId: sessionId }, data: CLEARED_CHECKOUT });
  }

  staleSubscriptions(before: Date, take: number) {
    return this.prisma.subscription.findMany({
      where: {
        stripeSubscriptionId: { not: null },
        status: { notIn: [...TERMINAL_STATUSES] },
        OR: [{ syncedAt: null }, { syncedAt: { lt: before } }],
      },
      select: { orgId: true, stripeSubscriptionId: true },
      orderBy: { syncedAt: { sort: 'asc', nulls: 'first' } },
      take,
    });
  }

  organization(orgId: string) {
    return this.prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true } });
  }

  async userEmail(orgId: string, userId: string): Promise<string | null> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, orgId }, select: { email: true } });
    return user?.email ?? null;
  }

  countActiveMembers(orgId: string, db: Db = this.prisma): Promise<number> {
    return db.user.count({ where: { orgId, status: BaseStatus.active } });
  }

  async hasBillingHistory(orgId: string): Promise<boolean> {
    return (await this.prisma.invoice.count({ where: { orgId } })) > 0;
  }

  /** orgId is set on create only; an invoice never changes organization. */
  upsertInvoice(stripeInvoiceId: string, data: Omit<Prisma.InvoiceUncheckedCreateInput, 'stripeInvoiceId'>) {
    const { orgId: _orgId, ...update } = data;
    return this.prisma.invoice.upsert({ where: { stripeInvoiceId }, create: { ...data, stripeInvoiceId }, update });
  }

  findPayment(stripeInvoiceId: string) {
    return this.prisma.payment.findUnique({ where: { stripeInvoiceId } });
  }

  upsertPayment(stripeInvoiceId: string, data: Omit<Prisma.PaymentUncheckedCreateInput, 'stripeInvoiceId'>) {
    const { orgId: _orgId, ...update } = data;
    return this.prisma.payment.upsert({ where: { stripeInvoiceId }, create: { ...data, stripeInvoiceId }, update });
  }

  listInvoices(orgId: string, query: ListQuery) {
    return paginate(query, {
      where: { orgId } as Prisma.InvoiceWhereInput,
      filters: { status: { type: 'enum', values: Object.values(InvoiceStatus) } },
      sortableFields: ['issuedAt', 'amountDue'] as const,
      defaultSort: [{ issuedAt: 'desc' }],
      findMany: (args) => this.prisma.invoice.findMany({ ...args, select: INVOICE_FIELDS }),
      count: (args) => this.prisma.invoice.count(args),
    });
  }

  /** Stores the event once; a redelivery returns the existing row. */
  async recordEvent(event: {
    stripeEventId: string;
    eventType: string;
    livemode: boolean;
    metadata: Prisma.InputJsonValue;
    stripeCreatedAt: Date;
  }) {
    try {
      return await this.prisma.billingEvent.create({ data: event });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.billingEvent.findUniqueOrThrow({ where: { stripeEventId: event.stripeEventId } });
      }
      throw error;
    }
  }

  findEvent(id: string) {
    return this.prisma.billingEvent.findUniqueOrThrow({ where: { id } });
  }

  /** Atomically claims a pending/failed/stale event. False if another worker holds it or it is done. */
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

  finishEvent(id: string, result: { status: FinishedEventStatus; orgId?: string | null; error?: string }) {
    return this.prisma.billingEvent.update({
      where: { id },
      data: {
        processingStatus: result.status,
        ...(result.orgId !== undefined ? { orgId: result.orgId } : {}),
        errorMessage: result.error ? result.error.slice(0, 1000) : null,
        processedAt: result.status === BillingEventStatus.failed ? null : new Date(),
      },
    });
  }

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
