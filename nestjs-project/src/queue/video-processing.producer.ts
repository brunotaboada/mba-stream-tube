import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import videoConfig from '../config/video.config';
import { PROCESS_VIDEO_JOB, VIDEO_PROCESSING_QUEUE } from './queue.constants';
import type { ProcessVideoJobData } from './video-processing-job.types';

const BACKOFF_DELAY_MS = 5000;

@Injectable()
export class VideoProcessingProducer {
  private readonly logger = new Logger(VideoProcessingProducer.name);

  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  /**
   * Queues a video for processing. The job id is the video id, so enqueuing
   * the same video twice collapses into a single job — which is what makes
   * re-enqueuing a stuck video safe.
   */
  async enqueueVideoProcessing(videoId: string): Promise<void> {
    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      {
        jobId: videoId,
        attempts: this.config.processingAttempts,
        backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
        removeOnComplete: true,
        // Failures stay in the queue so they remain inspectable.
        removeOnFail: false,
      },
    );
    this.logger.log(`Queued video ${videoId} for processing`);
  }
}
