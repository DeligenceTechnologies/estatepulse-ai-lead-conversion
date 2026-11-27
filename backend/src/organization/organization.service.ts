import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { rethrowPrismaError } from '@/common/prisma/prisma-errors';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

@Injectable()
export class OrganizationService {
  constructor(private readonly prisma: PrismaService) {}

  async findOne(id: string) {
    try {
      return await this.prisma.organization.findUniqueOrThrow({ where: { id } });
    } catch (error) {
      rethrowPrismaError(error, 'Organization');
    }
  }

  async update(id: string, dto: UpdateOrganizationDto) {
    try {
      return await this.prisma.organization.update({ where: { id }, data: dto });
    } catch (error) {
      rethrowPrismaError(error, 'Organization');
    }
  }

  async remove(id: string) {
    // Deleting the organization would not stop Stripe charging it.
    const subscription = await this.prisma.subscription.findUnique({ where: { orgId: id }, select: { stripeSubscriptionId: true, status: true } });
    if (subscription?.stripeSubscriptionId && !['canceled', 'incomplete_expired'].includes(subscription.status)) {
      throw new ConflictException('Cancel the subscription in Billing before deleting the organization.');
    }
    try {
      return await this.prisma.organization.delete({ where: { id } });
    } catch (error) {
      rethrowPrismaError(error, 'Organization');
    }
  }
}
