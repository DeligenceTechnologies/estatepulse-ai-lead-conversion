import { Global, Module, Provider, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';

import { MailService } from '@/common/service/mail.service';
import {
  PrismaService,
  TENANT_PRISMA,
  type GuardedPrisma,
} from '@/common/prisma/prisma.service';
import { TenantContextInterceptor } from '@/common/prisma/tenant-context';

const SERVICES: Provider[] = [
  PrismaService,
  MailService,
];

const TENANT_PRISMA_PROVIDER: Provider = {
  provide: TENANT_PRISMA,
  inject: [PrismaService],
  useFactory: (prisma: PrismaService): GuardedPrisma =>
      prisma.withTenancyGuard(),
};

const GLOBAL_PROVIDERS: Provider[] = [
  {
    provide: APP_PIPE,
    useValue: new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  },
  {
    provide: APP_INTERCEPTOR,
    useClass: TenantContextInterceptor,
  },
];

@Global()
@Module({
  providers: [
    ...SERVICES,
    TENANT_PRISMA_PROVIDER,
    ...GLOBAL_PROVIDERS,
  ],
  exports: [
    ...SERVICES,
    TENANT_PRISMA,
  ],
})
export class ServiceProviderModule {}