import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from './video-status.enum';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_ent_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `channel_${n}`,
        nickname: `video_ent_${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channel: Channel, publicId: string): Video {
    return videoRepository.create({
      public_id: publicId,
      channel_id: channel.id,
      title: 'A video',
      storage_key: 'key/source.mp4',
      original_filename: 'source.mp4',
      content_type: 'video/mp4',
    });
  }

  it('defaults status to draft', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      buildVideo(channel, 'pub_draft_1'),
    );

    expect(saved.status).toBe(VideoStatus.DRAFT);
  });

  it('rejects a public_id longer than the column width', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(buildVideo(channel, 'x'.repeat(17))),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('rejects a duplicate public_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel, 'dup_public'));

    await expect(
      videoRepository.save(buildVideo(channel, 'dup_public')),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('rejects a video whose channel does not exist', async () => {
    const orphan = videoRepository.create({
      public_id: 'orphan_1',
      channel_id: '00000000-0000-0000-0000-000000000000',
      title: 'Orphan',
      storage_key: 'key/source.mp4',
      original_filename: 'source.mp4',
      content_type: 'video/mp4',
    });

    await expect(videoRepository.save(orphan)).rejects.toBeInstanceOf(
      QueryFailedError,
    );
  });

  it('leaves processing fields null until the video is processed', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel, 'pub_null_1'));

    expect(saved.duration_seconds).toBeNull();
    expect(saved.width).toBeNull();
    expect(saved.height).toBeNull();
    expect(saved.thumbnail_key).toBeNull();
    expect(saved.metadata).toBeNull();
    expect(saved.processing_error).toBeNull();
  });

  it('round-trips the raw ffprobe document through the jsonb column', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel, 'pub_json_1');
    video.metadata = {
      format: { duration: '5.000', format_name: 'mov,mp4,m4a' },
      streams: [{ codec_type: 'video', width: 640, height: 480 }],
    };

    const saved = await videoRepository.save(video);
    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(reloaded.metadata).toEqual(video.metadata);
  });

  it('accepts every status in the lifecycle', async () => {
    const channel = await createChannel();

    const statuses = [
      VideoStatus.DRAFT,
      VideoStatus.PROCESSING,
      VideoStatus.READY,
      VideoStatus.FAILED,
    ];

    for (const [index, status] of statuses.entries()) {
      const video = buildVideo(channel, `pub_st_${index}`);
      video.status = status;
      const saved = await videoRepository.save(video);
      expect(saved.status).toBe(status);
    }
  });

  it('cascades deletion when the owning channel is removed', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel, 'pub_cascade_1'));

    await channelRepository.delete({ id: channel.id });

    await expect(
      videoRepository.findOneBy({ public_id: 'pub_cascade_1' }),
    ).resolves.toBeNull();
  });
});
