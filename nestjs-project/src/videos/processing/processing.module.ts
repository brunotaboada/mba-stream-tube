import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import videoConfig from '../../config/video.config';
import { QueueModule } from '../../queue/queue.module';
import { StorageModule } from '../../storage/storage.module';
import { Video } from '../entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingConsumer } from './video-processing.consumer';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ConfigModule.forFeature(videoConfig),
    StorageModule,
    QueueModule,
  ],
  providers: [FfmpegService, VideoProcessingConsumer],
  exports: [FfmpegService],
})
export class ProcessingModule {}
