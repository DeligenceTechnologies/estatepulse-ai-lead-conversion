import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { envValidationSchema } from './env.validation';

@Global()
@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            validationSchema: envValidationSchema,
        }),
    ],
    exports: [ConfigModule],
})
export class AppConfigModule {}