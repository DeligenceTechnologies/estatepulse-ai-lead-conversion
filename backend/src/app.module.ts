import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import {ServiceProviderModule} from "@/common/provider/service.provider";
import {AppConfigModule} from "@/common/config/config.module";
import { OrganizationModule } from './organization/organization.module';
import { UserModule } from './user/user.module';
import { AuthModule } from './auth/auth.module';
import { RoleModule } from './role/role.module';
import { OrgSettingModule } from './org-setting/org-setting.module';
import { CalendarModule } from './calendar/calendar.module';
import { EventsModule } from './events/events.module';
import { LeadModule } from './lead/lead.module';
import { AgentModule } from './agent/agent.module';
import { TelnyxModule } from './telnyx/telnyx.module';
import { TransferModule } from './transfer/transfer.module';
import { FollowupModule } from './followup/followup.module';
import { OutreachModule } from './outreach/outreach.module';
import { HistoryModule } from './history/history.module';
import { DailySummaryModule } from './daily-summary/daily-summary.module';
import { BillingModule } from './billing/billing.module';
import { HealthController } from './health.controller';
import {QueueModule} from "@/queue/queue.module";

@Module({
  imports: [
    AppConfigModule,
    ServiceProviderModule,
    ScheduleModule.forRoot(),
    AuthModule,
    OrganizationModule,
    UserModule,
    RoleModule,
    OrgSettingModule,
    CalendarModule,
    EventsModule,
    LeadModule,
    AgentModule,
    TelnyxModule,
    TransferModule,
    FollowupModule,
    OutreachModule,
    HistoryModule,
    DailySummaryModule,
    BillingModule,
    QueueModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}