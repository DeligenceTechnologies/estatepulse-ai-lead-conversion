import { Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Outbound email. ConfigModule is global (see app.module.ts), so MailService
 * needs nothing imported here.
 */
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
