import { Job } from 'bullmq';
import { VideoStatus } from '../entities/video-status.enum';
import { VideoProcessingConsumer } from './video-processing.consumer';

const config = {
  maxSizeBytes: 10737418240,
  uploadPartSizeBytes: 104857600,
  allowedMimeTypes: ['video/mp4'],
  processingAttempts: 3,
  ffmpegTimeoutMs: 300000,
};

function build(video: unknown) {
  const repository = {
    findOne: jest.fn().mockResolvedValue(video),
    save: jest.fn((entity: unknown) => Promise.resolve(entity)),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    videosBucket: 'videos',
    thumbnailsBucket: 'thumbs',
    getObjectStream: jest.fn(),
    putObject: jest.fn().mockResolvedValue(undefined),
  };
  const ffmpeg = {
    probe: jest.fn(),
    extractThumbnail: jest.fn(),
    computeThumbnailTimestamp: jest.fn().mockReturnValue(1),
  };
  const consumer = new VideoProcessingConsumer(
    repository as never,
    storage as never,
    ffmpeg as never,
    config,
  );
  return { consumer, repository, storage, ffmpeg };
}

function job(videoId: string, attemptsMade = 1): Job<{ videoId: string }> {
  return {
    data: { videoId },
    attemptsMade,
    opts: { attempts: 3 },
  } as Job<{ videoId: string }>;
}

describe('VideoProcessingConsumer', () => {
  it('does no work when the video row is gone', async () => {
    const { consumer, storage } = build(null);

    await expect(consumer.process(job('missing'))).resolves.toBeUndefined();
    expect(storage.getObjectStream).not.toHaveBeenCalled();
  });

  it('skips a video that is already ready', async () => {
    const { consumer, storage, ffmpeg } = build({
      id: 'video-1',
      status: VideoStatus.READY,
      storage_key: 'video-1/source.mp4',
    });

    await consumer.process(job('video-1'));

    expect(storage.getObjectStream).not.toHaveBeenCalled();
    expect(ffmpeg.probe).not.toHaveBeenCalled();
  });

  it('does not mark the video failed while attempts remain', async () => {
    const { consumer, repository } = build({ id: 'video-1' });

    await consumer.onFailed(job('video-1', 1), new Error('boom'));

    expect(repository.update).not.toHaveBeenCalled();
  });

  it('marks the video failed once attempts are exhausted', async () => {
    const { consumer, repository } = build({ id: 'video-1' });

    await consumer.onFailed(job('video-1', 3), new Error('boom'));

    expect(repository.update).toHaveBeenCalledWith(
      { id: 'video-1' },
      expect.objectContaining({
        status: VideoStatus.FAILED,
        processing_error: 'boom',
      }),
    );
  });

  it('truncates a very long failure reason', async () => {
    const { consumer, repository } = build({ id: 'video-1' });

    await consumer.onFailed(job('video-1', 3), new Error('x'.repeat(5000)));

    const stored = repository.update.mock.calls[0][1] as {
      processing_error: string;
    };
    expect(stored.processing_error.length).toBe(1000);
  });
});
