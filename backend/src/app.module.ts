import { Module } from '@nestjs/common';
import {ServiceProviderModule} from "@/common/provider/service.provider";
import {AppConfigModule} from "@/common/config/config.module";
import { OrganizationModule } from './organization/organization.module';
import { UserModule } from './user/user.module';
import { AuthModule } from './auth/auth.module';
import { RoleModule } from './role/role.module';

@Module({
  imports: [
    AppConfigModule,
    ServiceProviderModule,
    AuthModule,
    OrganizationModule,
    UserModule,
    RoleModule,
  ],
})
export class AppModule {}