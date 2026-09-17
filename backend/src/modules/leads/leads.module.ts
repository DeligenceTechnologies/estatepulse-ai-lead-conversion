import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { LeadsController } from './leads.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [LeadsController],
})
export class LeadsModule {}
