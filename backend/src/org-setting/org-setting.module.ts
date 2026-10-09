import { Module } from '@nestjs/common';
import { OrgSettingController } from './org-setting.controller';
import { OrgSettingService } from './org-setting.service';

@Module({
  controllers: [OrgSettingController],
  providers: [OrgSettingService],
})
export class OrgSettingModule {}
