import { QueryFailedError } from 'typeorm';
import { VideoStatus } from './entities/video-status.enum';
import { Video } from './entities/video.entity';
import {
  ChannelNotFoundException,
  InvalidVideoStateException,
  UnsupportedVideoFormatException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
} from './exceptions/video.exceptions';
import { VideosService, sanitizeDownloadFilename } from './videos.service';

const config = {
  maxSizeBytes: 10737418240,
  uploadPartSizeBytes: 100 * 1024 * 1024,
  allowedMimeTypes: ['video/mp4', 'video/webm'],
  processingAttempts: 3,
  ffmpegTimeoutMs: 300000,
};

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    public_id: 'pub1234567',
    channel_id: 'channel-1',
    title: 'A video',
    status: VideoStatus.DRAFT,
    storage_key: 'video-1/source.mp4',
    upload_id: 'upload-1',
    thumbnail_key: null,
    original_filename: 'source.mp4',
    content_type: 'video/mp4',
    size_bytes: '1000',
    duration_seconds: null,
    width: null,
    height: null,
    video_codec: null,
    audio_codec: null,
    bitrate: null,
    metadata: null,
    processing_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: { id: 'channel-1', nickname: 'nick', name: 'Name' } as never,
    ...overrides,
  } as Video;
}

function build(
  overrides: {
    repository?: Record<string, jest.Mock>;
    channels?: Record<string, jest.Mock>;
    storage?: Record<string, unknown>;
    producer?: Record<string, jest.Mock>;
  } = {},
) {
  const repository = {
    create: jest.fn((data: Partial<Video>) => makeVideo(data)),
    save: jest.fn((video: Video) => Promise.resolve(video)),
    findOne: jest.fn(),
    remove: jest.fn().mockResolvedValue(undefined),
    ...overrides.repository,
  };
  const channels = {
    findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
    ...overrides.channels,
  };
  const storage = {
    videosBucket: 'videos',
    thumbnailsBucket: 'thumbs',
    urlExpirationSeconds: 900,
    createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
    getPartUploadUrls: jest.fn().mockResolvedValue([]),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    getPresignedDownloadUrl: jest.fn().mockResolvedValue('https://signed'),
    ...overrides.storage,
  };
  const producer = {
    enqueueVideoProcessing: jest.fn().mockResolvedValue(undefined),
    ...overrides.producer,
  };

  const service = new VideosService(
    repository as never,
    channels as never,
    storage as never,
    producer as never,
    config,
  );
  return { service, repository, channels, storage, producer };
}

describe('VideosService', () => {
  describe('initiateUpload', () => {
    const dto = {
      filename: 'holiday.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1000,
    };

    it('rejects a content type outside the allowlist', async () => {
      const { service, storage } = build();

      await expect(
        service.initiateUpload('user-1', { ...dto, contentType: 'text/plain' }),
      ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('rejects a declared size above the maximum before touching storage', async () => {
      const { service, storage } = build();

      await expect(
        service.initiateUpload('user-1', {
          ...dto,
          sizeBytes: config.maxSizeBytes + 1,
        }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('accepts a declared size exactly at the maximum', async () => {
      const { service } = build();

      await expect(
        service.initiateUpload('user-1', {
          ...dto,
          sizeBytes: config.maxSizeBytes,
        }),
      ).resolves.toBeDefined();
    });

    it('rejects a user without a channel', async () => {
      const { service } = build({
        channels: { findByUserId: jest.fn().mockResolvedValue(null) },
      });

      await expect(
        service.initiateUpload('user-1', dto),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);
    });

    it('requests one presigned part per configured chunk, rounding up', async () => {
      const { service, storage } = build();

      // The 10 GiB maximum at a 100 MiB part size is 102.4 parts, so the
      // last, partial part must still get a URL.
      await service.initiateUpload('user-1', {
        ...dto,
        sizeBytes: config.maxSizeBytes,
      });

      expect(storage.getPartUploadUrls).toHaveBeenCalledWith(
        expect.any(String),
        'upload-1',
        103,
      );
    });

    it('requests a single part for a file smaller than one chunk', async () => {
      const { service, storage } = build();

      await service.initiateUpload('user-1', { ...dto, sizeBytes: 1024 });

      expect(storage.getPartUploadUrls).toHaveBeenCalledWith(
        expect.any(String),
        'upload-1',
        1,
      );
    });

    it('derives the title from the filename when none is supplied', async () => {
      const { service, repository } = build();

      await service.initiateUpload('user-1', dto);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'holiday' }),
      );
    });

    it('keeps an explicit title', async () => {
      const { service, repository } = build();

      await service.initiateUpload('user-1', { ...dto, title: 'Chosen' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Chosen' }),
      );
    });

    it('regenerates the public id when the unique index rejects it', async () => {
      const collision = new QueryFailedError('INSERT', [], new Error());
      Object.assign(collision, {
        code: '23505',
        detail: 'Key (public_id)=(abc) already exists.',
      });
      const save = jest
        .fn()
        .mockRejectedValueOnce(collision)
        .mockImplementation((video: Video) => Promise.resolve(video));
      const { service, repository } = build({ repository: { save } });

      await expect(
        service.initiateUpload('user-1', dto),
      ).resolves.toBeDefined();
      expect(repository.create).toHaveBeenCalledTimes(2);
    });

    it('propagates a database error that is not a public id collision', async () => {
      const other = new QueryFailedError('INSERT', [], new Error());
      Object.assign(other, { code: '23503', detail: 'FK violation' });
      const { service } = build({
        repository: { save: jest.fn().mockRejectedValue(other) },
      });

      await expect(service.initiateUpload('user-1', dto)).rejects.toBe(other);
    });
  });

  describe('completeUpload', () => {
    const dto = { uploadId: 'upload-1', parts: [{ partNumber: 1, etag: 'a' }] };

    it('moves the video to processing and enqueues exactly one job', async () => {
      const video = makeVideo();
      const { service, storage, producer } = build({
        repository: { findOne: jest.fn().mockResolvedValue(video) },
      });

      const result = await service.completeUpload('user-1', 'video-1', dto);

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'video-1/source.mp4',
        'upload-1',
        dto.parts,
      );
      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(result.upload_id).toBeNull();
      expect(producer.enqueueVideoProcessing).toHaveBeenCalledTimes(1);
      expect(producer.enqueueVideoProcessing).toHaveBeenCalledWith('video-1');
    });

    it('reports another channel video as not found', async () => {
      const { service } = build({
        repository: {
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ channel_id: 'other-channel' })),
        },
      });

      await expect(
        service.completeUpload('user-1', 'video-1', dto),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('rejects completing a video that is not a draft', async () => {
      const { service, producer } = build({
        repository: {
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: VideoStatus.READY })),
        },
      });

      await expect(
        service.completeUpload('user-1', 'video-1', dto),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
      expect(producer.enqueueVideoProcessing).not.toHaveBeenCalled();
    });

    it('does not transition the video when storage fails to assemble it', async () => {
      const video = makeVideo();
      const { service, producer } = build({
        repository: { findOne: jest.fn().mockResolvedValue(video) },
        storage: {
          completeMultipartUpload: jest
            .fn()
            .mockRejectedValue(new Error('missing part')),
        },
      });

      await expect(
        service.completeUpload('user-1', 'video-1', dto),
      ).rejects.toThrow('missing part');
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(producer.enqueueVideoProcessing).not.toHaveBeenCalled();
    });
  });

  describe('abortUpload', () => {
    it('aborts the multipart upload and removes the draft', async () => {
      const video = makeVideo();
      const { service, storage, repository } = build({
        repository: { findOne: jest.fn().mockResolvedValue(video) },
      });

      await service.abortUpload('user-1', 'video-1');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'video-1/source.mp4',
        'upload-1',
      );
      expect(repository.remove).toHaveBeenCalledWith(video);
    });

    it('refuses to abort a video that already left draft', async () => {
      const { service, repository } = build({
        repository: {
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: VideoStatus.PROCESSING })),
        },
      });

      await expect(
        service.abortUpload('user-1', 'video-1'),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
      expect(repository.remove).not.toHaveBeenCalled();
    });
  });

  describe('public resolution', () => {
    it('raises not found for an unknown public id', async () => {
      const { service } = build({
        repository: { findOne: jest.fn().mockResolvedValue(null) },
      });

      await expect(service.findByPublicId('nope')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'hides a video in %s from public resolution',
      async (status) => {
        const { service } = build({
          repository: {
            findOne: jest.fn().mockResolvedValue(makeVideo({ status })),
          },
        });

        await expect(
          service.findReadyByPublicId('pub1234567'),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
      },
    );

    it('returns a processing video to the channel that owns it', async () => {
      const { service } = build({
        repository: {
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: VideoStatus.PROCESSING })),
        },
      });

      await expect(
        service.findForViewer('pub1234567', 'user-1'),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });
    });

    it('hides a processing video from an anonymous viewer', async () => {
      const { service } = build({
        repository: {
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: VideoStatus.PROCESSING })),
        },
      });

      await expect(service.findForViewer('pub1234567')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('hides a processing video from a different channel', async () => {
      const { service } = build({
        repository: {
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: VideoStatus.PROCESSING })),
        },
        channels: {
          findByUserId: jest.fn().mockResolvedValue({ id: 'other-channel' }),
        },
      });

      await expect(
        service.findForViewer('pub1234567', 'stranger'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('returns a ready video to anyone without consulting channels', async () => {
      const { service, channels } = build({
        repository: {
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: VideoStatus.READY })),
        },
      });

      await expect(service.findForViewer('pub1234567')).resolves.toBeDefined();
      expect(channels.findByUserId).not.toHaveBeenCalled();
    });

    it('signs a download URL with a sanitised attachment filename', async () => {
      const { service, storage } = build({
        repository: {
          findOne: jest.fn().mockResolvedValue(
            makeVideo({
              status: VideoStatus.READY,
              original_filename: 'my "clip".mp4',
            }),
          ),
        },
      });

      await service.getDownloadUrl('pub1234567');

      expect(storage.getPresignedDownloadUrl).toHaveBeenCalledWith(
        'videos',
        'video-1/source.mp4',
        expect.objectContaining({ downloadFilename: 'my clip.mp4' }),
      );
    });

    it('signs a plain stream URL without a disposition override', async () => {
      const { service, storage } = build({
        repository: {
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: VideoStatus.READY })),
        },
      });

      await service.getStreamUrl('pub1234567');

      expect(storage.getPresignedDownloadUrl).toHaveBeenCalledWith(
        'videos',
        'video-1/source.mp4',
      );
    });
  });
});

describe('sanitizeDownloadFilename', () => {
  it('strips quotes that would break the header', () => {
    expect(sanitizeDownloadFilename('a"b.mp4')).toBe('ab.mp4');
  });

  it('keeps only the final path segment', () => {
    expect(sanitizeDownloadFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeDownloadFilename('C:\\videos\\clip.mp4')).toBe('clip.mp4');
  });

  it('preserves spaces and unicode', () => {
    expect(sanitizeDownloadFilename('meu vídeo.mp4')).toBe('meu vídeo.mp4');
  });

  it('falls back when nothing usable remains', () => {
    expect(sanitizeDownloadFilename('"""')).toBe('video');
  });
});
