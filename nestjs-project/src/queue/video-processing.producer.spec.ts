import { PROCESS_VIDEO_JOB } from './queue.constants';
import { VideoProcessingProducer } from './video-processing.producer';

const videoSettings = {
  maxSizeBytes: 10737418240,
  uploadPartSizeBytes: 104857600,
  allowedMimeTypes: ['video/mp4'],
  processingAttempts: 3,
  ffmpegTimeoutMs: 300000,
};

describe('VideoProcessingProducer', () => {
  it('enqueues a thin payload keyed by the video id', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const producer = new VideoProcessingProducer(queue as any, videoSettings);

    await producer.enqueueVideoProcessing('video-1');

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, options] = queue.add.mock.calls[0];
    expect(name).toBe(PROCESS_VIDEO_JOB);
    expect(data).toEqual({ videoId: 'video-1' });
    expect(options).toMatchObject({
      jobId: 'video-1',
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  });

  it('takes the retry count from configuration', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const producer = new VideoProcessingProducer(queue as any, {
      ...videoSettings,
      processingAttempts: 7,
    });

    await producer.enqueueVideoProcessing('video-2');

    expect(queue.add.mock.calls[0][2]).toMatchObject({ attempts: 7 });
  });
});
