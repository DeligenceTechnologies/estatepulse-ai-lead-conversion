import { Global, Module } from '@nestjs/common';
import { EventsBus } from './events.bus';
import { EventsController } from './events.controller';

@Global()
@Module({
  controllers: [EventsController],
  providers: [EventsBus],
  exports: [EventsBus],
})
export class EventsModule {}
