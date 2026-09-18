import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { EventsBus } from './events.bus';
import { EventsController } from './events.controller';

/**
 * Global, because the publishers are scattered by nature: anything that commits
 * a change a live screen cares about should be able to say so without its module
 * growing an import for the privilege. The alternative — threading this through
 * every module that writes — is how a publish gets quietly dropped from the one
 * path that needed it.
 */
@Global()
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [EventsController],
  providers: [EventsBus],
  exports: [EventsBus],
})
export class EventsModule {}
