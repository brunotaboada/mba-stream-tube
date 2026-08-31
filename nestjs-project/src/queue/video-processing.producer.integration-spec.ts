import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import videoConfig from '../config/video.config';
import { QueueModule } from './queue.module';
import { PROCESS_VIDEO_JOB, VIDEO_PROCESSING_QUEUE } from './queue.constants';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration)', () => {
  let moduleRef: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, videoConfig],
        }),
        QueueModule,
      ],
    }).compile();

    producer = moduleRef.get(VideoProcessingProducer);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('adds a job to the real Redis-backed queue', async () => {
    await producer.enqueueVideoProcessing('video-integration-1');

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe(PROCESS_VIDEO_JOB);
    expect(jobs[0].data).toEqual({ videoId: 'video-integration-1' });
    expect(jobs[0].opts.attempts).toBe(3);
    expect(jobs[0].opts.backoff).toMatchObject({ type: 'exponential' });
  }, 30000);

  it('collapses a duplicate enqueue for the same video into one job', async () => {
    await producer.enqueueVideoProcessing('video-integration-dup');
    await producer.enqueueVideoProcessing('video-integration-dup');

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
  }, 30000);

  it('keeps separate jobs for different videos', async () => {
    await producer.enqueueVideoProcessing('video-a');
    await producer.enqueueVideoProcessing('video-b');

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(2);
  }, 30000);
});
