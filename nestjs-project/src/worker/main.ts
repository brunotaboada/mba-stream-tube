import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  // An application context, not an HTTP server: the worker only consumes jobs.
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: false,
  });

  // Lets an in-flight FFmpeg run finish instead of being cut off on SIGTERM.
  app.enableShutdownHooks();

  Logger.log('Video worker started and listening for jobs', 'Worker');
}

void bootstrap();
