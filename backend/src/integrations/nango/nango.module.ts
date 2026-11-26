import { Module } from '@nestjs/common';
import { NangoService } from './nango.service';

/**
 * Nango on its own, so modules that use a Nango-held connection (the calendar
 * reads its Cal.com key from here) can import it without importing the whole
 * marketplace, which itself depends on them.
 */
@Module({
  providers: [NangoService],
  exports: [NangoService],
})
export class NangoModule {}
