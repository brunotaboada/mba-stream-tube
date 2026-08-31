import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { envValidationSchema } from '../config/env.validation';
import { UsersModule } from '../users/users.module';
import { ProcessingModule } from '../videos/processing/processing.module';

/**
 * Root module of the worker process. It deliberately does not import
 * AppModule: the worker serves no HTTP traffic, so it registers no
 * controllers and no global guard.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig, videoConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres' as const,
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    // Video relates to Channel, which relates to User. autoLoadEntities only
    // discovers entities registered by an imported module, so the owning
    // modules are imported rather than the entities re-declared here.
    UsersModule,
    ProcessingModule,
  ],
})
export class WorkerModule {}
