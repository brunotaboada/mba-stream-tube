import { createWriteStream } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import videoConfig from '../../config/video.config';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import type { ProcessVideoJobData } from '../../queue/video-processing-job.types';
import { StorageService } from '../../storage/storage.service';
import { VideoStatus } from '../entities/video-status.enum';
import { Video } from '../entities/video.entity';
import { FfmpegService } from './ffmpeg.service';

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

/**
 * Turns an uploaded object into a ready video: download, probe, thumbnail,
 * persist. Delivery is at-least-once, so the handler reloads current state
 * and is safe to run more than once for the same video.
 */
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessingConsumer extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingConsumer.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    if (!video) {
      // The video was deleted while the job waited; nothing to do.
      this.logger.warn(`Video ${videoId} no longer exists, skipping job`);
      return;
    }

    if (video.status === VideoStatus.READY) {
      this.logger.log(`Video ${videoId} is already processed, skipping`);
      return;
    }

    const workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
    const sourcePath = join(workDir, 'source');
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      await this.downloadSource(video.storage_key, sourcePath);

      const metadata = await this.ffmpegService.probe(sourcePath);

      const timestamp = this.ffmpegService.computeThumbnailTimestamp(
        metadata.durationSeconds,
      );
      await this.ffmpegService.extractThumbnail(
        sourcePath,
        thumbnailPath,
        timestamp,
      );

      const thumbnailKey = `${video.id}.jpg`;
      await this.storageService.putObject(
        this.storageService.thumbnailsBucket,
        thumbnailKey,
        await readFile(thumbnailPath),
        THUMBNAIL_CONTENT_TYPE,
      );

      video.duration_seconds = metadata.durationSeconds.toFixed(3);
      video.width = metadata.width;
      video.height = metadata.height;
      video.video_codec = metadata.videoCodec;
      video.audio_codec = metadata.audioCodec;
      video.bitrate = metadata.bitrate;
      if (metadata.sizeBytes !== null) {
        video.size_bytes = String(Math.trunc(metadata.sizeBytes));
      }
      video.metadata = metadata.raw as Record<string, unknown>;
      video.thumbnail_key = thumbnailKey;
      video.processing_error = null;
      video.status = VideoStatus.READY;

      await this.videoRepository.save(video);
      this.logger.log(`Video ${videoId} processed successfully`);
    } finally {
      // Multi-GB scratch files must never survive a failure.
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async downloadSource(key: string, target: string): Promise<void> {
    const stream = await this.storageService.getObjectStream(
      this.storageService.videosBucket,
      key,
    );
    await pipeline(stream, createWriteStream(target));
  }

  /**
   * Only the final attempt is terminal: earlier failures are retried by
   * BullMQ with backoff, so the row stays in processing until then.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, error: Error): Promise<void> {
    const attemptsMade = job.attemptsMade ?? 0;
    const maxAttempts = job.opts?.attempts ?? this.config.processingAttempts;

    this.logger.error(
      `Processing failed for video ${job.data?.videoId} ` +
        `(attempt ${attemptsMade}/${maxAttempts}): ${error.message}`,
    );

    if (attemptsMade < maxAttempts) {
      return;
    }

    await this.videoRepository.update(
      { id: job.data.videoId },
      {
        status: VideoStatus.FAILED,
        processing_error: error.message.slice(0, 1000),
      },
    );
  }
}
